const Docker = require('dockerode');

class SessionManager {
  constructor() {
    this.sessions = new Map();

    // Configure Docker client
    const dockerOptions = {};

    if (process.env.DOCKER_HOST) {
      const hostParts = process.env.DOCKER_HOST.replace('tcp://', '').split(':');
      dockerOptions.host = hostParts[0];
      dockerOptions.port = parseInt(hostParts[1]) || 2375;
    }

    this.docker = new Docker(dockerOptions);
    this.maxSessions = 40;
    // Idle timeout — kill a session if no USER INPUT arrives for this long.
    // Reset only on sendInput, not on resize (resize is passive / happens
    // on scroll or viewport change and shouldn't count as engagement).
    this.sessionTimeout = 5 * 60 * 1000; // 5 minutes
    // Bot kill — if a session never receives ANY user input within this
    // window, assume it's a background tab / bot and free the slot.
    this.noInputTimeout = 60 * 1000; // 60 seconds
    this.imagePreloaded = false;

    // Container pre-warm pool: always keep `poolSize` containers ready-to-go
    // so new connections skip the 1-2s createContainer latency. On assign,
    // we replenish the pool in the background.
    this.pool = [];
    this.poolSize = 5;
    this.poolWarming = 0;
    this._poolBackoffMs = 0;
    this.zombieSessions = new Map();
    // Resizes that arrive before the session is stored (fresh container path)
    // are buffered here and applied once the session is ready.
    this.pendingResizes = new Map();

    // Preload the image on startup, then fill the pool.
    this.preloadImage().then(() => {
      if (this.imagePreloaded) this.fillPool();
    });
  }

  // Spec shared by pool-warm and fresh-create so both end up with identical
  // containers. Hardened security settings + UTF-8 locale + no network.
  _containerSpec(sessionId) {
    return {
      Image: 'twaldin/terminal-portfolio:latest',
      Hostname: 'twaldin',
      Tty: true,
      OpenStdin: true,
      StdinOnce: false,
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: true,
      Env: [
        'TERM=xterm-256color',
        'PS1=tim.waldin.net:$ ',
        'LANG=C.UTF-8',
        'LC_ALL=C.UTF-8',
      ],
      WorkingDir: '/home/portfolio',
      User: 'portfolio',
      Labels: {
        'app': 'terminal-portfolio',
        'session': sessionId || 'pool',
      },
      HostConfig: {
        Memory: 512 * 1024 * 1024,
        CpuQuota: 50000,
        PidsLimit: 100,
        ReadonlyRootfs: false,
        NetworkMode: 'none',
        CapDrop: ['ALL'],
        CapAdd: ['SETUID', 'SETGID'], // needed for sudo; no escape surface
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=100m' },
      },
    };
  }

  fillPool() {
    if (!this.imagePreloaded) return;
    while (this.pool.length + this.poolWarming < this.poolSize) {
      this.poolWarming++;
      this.warmOne()
        .then(() => { this._poolBackoffMs = 0; })
        .catch((err) => {
          console.error('warmOne failed:', err.message);
          // Exponential backoff so a transient socket-proxy/DNS failure
          // (EAI_AGAIN) doesn't spin. Capped at 30s. The periodic
          // maintenance loop (startPoolMaintenance) retries after this.
          this._poolBackoffMs = Math.min((this._poolBackoffMs || 0) * 2 || 1000, 30000);
          this._lastWarmFailAt = Date.now();
        })
        .finally(() => { this.poolWarming--; });
    }
  }

  startPoolMaintenance() {
    if (this._poolMaintTimer) return; // single-flight
    this._poolMaintTimer = setInterval(() => {
      if (!this.imagePreloaded) return;
      // Honor backoff window after a recent failure.
      if (this._poolBackoffMs && this._lastWarmFailAt &&
          Date.now() - this._lastWarmFailAt < this._poolBackoffMs) return;
      if (this.pool.length < this.poolSize) {
        this.fillPool();
      }
    }, 15 * 1000); // top up every 15s
  }

  async warmOne() {
    const container = await this.docker.createContainer(this._containerSpec('pool'));
    await container.start();
    try {
      await container.resize({ h: 40, w: 140 });
    } catch { /* pre-resize best-effort */ }

    const stream = await container.attach({
      stream: true, stdin: true, stdout: true, stderr: true, hijack: true,
    });

    const item = {
      container,
      stream,
      buffer: [],
      promptSeen: false,
      alive: true,
      _onData: null,
      _onClose: null,
    };

    item._onData = (data) => {
      if (!item.alive) return;
      const str = data.toString();
      // Filter out Docker's attach preamble noise (same check as the live handler).
      if (str.includes('{"stream":true,"stdin":true,"stdout":true,"stderr":true,"hijack":true}')) return;
      item.buffer.push(str);
      if (!item.promptSeen && str.includes('~ ')) item.promptSeen = true;
    };
    item._onClose = () => {
      item.alive = false;
      this.pool = this.pool.filter((p) => p !== item);
      console.log(`Pool: container stream closed, ${this.pool.length}/${this.poolSize} ready (will top up)`);
    };
    stream.on('data', item._onData);
    stream.on('close', item._onClose);

    // Wait up to 10s for the zsh prompt to render into our buffer.
    const start = Date.now();
    while (item.alive && !item.promptSeen && Date.now() - start < 10000) {
      await new Promise((r) => setTimeout(r, 50));
    }

    if (!item.alive || !item.promptSeen) {
      // Something went wrong — tear the container down so it isn't leaked.
      item.alive = false;
      try { stream.off('data', item._onData); } catch { /* ignore */ }
      try { stream.off('close', item._onClose); } catch { /* ignore */ }
      try { await container.kill(); } catch { /* ignore */ }
      try { await container.remove({ force: true }); } catch { /* ignore */ }
      throw new Error('pool container did not produce prompt');
    }

    this.pool.push(item);
    console.log(`Pool: warmed container (${this.pool.length}/${this.poolSize} ready, ${this.poolWarming - 1} still warming)`);

    // Pre-populate the welcome output cache at the pool's default width (140).
    // The first visitor gets instant output; without this they'd wait for
    // figlet + animations to generate the cache.
    const promptBuffer = [...item.buffer]; // save just the initial prompt for user replay

    // Disable the data handler before sending welcome to prevent prompt bleed
    stream.off('data', item._onData);
    item._onData = null;

    item.stream.write('welcome\r');
    // Wait for welcome script + OMP prompt re-render to finish. 2s covers
    // even slow figlet first-run (cache miss) + OMP's git-status evaluation.
    await new Promise((r) => setTimeout(r, 2000));

    // Restore to just the initial prompt and ensure buffer is sealed
    item.buffer = promptBuffer;
    // Don't re-enable the data handler - the buffer should remain sealed
  }

  _grabFromPool() {
    while (this.pool.length) {
      const item = this.pool.shift();
      if (item.alive) return item;
    }
    return null;
  }

  async cleanupDockerSmart() {
    console.log('Smart Docker cleanup - keeping only recent images...');
    try {
      // Remove stopped containers AND leftover running portfolio containers from
      // a previous backend run (they'd otherwise linger for 60s until orphan
      // cleanup, plus any unclaimed pool containers from before a restart).
      const containers = await this.docker.listContainers({ all: true });
      for (const containerInfo of containers) {
        const isPortfolioLabel = (containerInfo.Labels || {})['app'] === 'terminal-portfolio';
        const shouldRemove = containerInfo.State !== 'running' || isPortfolioLabel;
        if (shouldRemove) {
          try {
            const container = this.docker.getContainer(containerInfo.Id);
            await container.remove({ force: true });
            console.log(`Removed ${containerInfo.State} container: ${containerInfo.Id}`);
          } catch (err) {
            console.log(`Could not remove container ${containerInfo.Id}:`, err.message);
          }
        }
      }

      // Get all images sorted by creation date (newest first)
      const images = await this.docker.listImages();
      const portfolioImages = images
        .filter(img => img.RepoTags && img.RepoTags.some(tag => tag.includes('terminal-portfolio')))
        .sort((a, b) => b.Created - a.Created);

      // Keep only the most recent portfolio image, remove the rest
      if (portfolioImages.length > 1) {
        console.log(`Found ${portfolioImages.length} portfolio images, keeping newest, removing ${portfolioImages.length - 1} old ones`);
        for (let i = 1; i < portfolioImages.length; i++) {
          try {
            const image = this.docker.getImage(portfolioImages[i].Id);
            await image.remove({ force: true });
            console.log(`Removed old portfolio image: ${portfolioImages[i].Id}`);
          } catch (err) {
            console.log(`Could not remove old image ${portfolioImages[i].Id}:`, err.message);
          }
        }
      }

      // Remove any dangling/untagged images
      const danglingImages = images.filter(img => !img.RepoTags || img.RepoTags.includes('<none>:<none>'));
      for (const img of danglingImages) {
        try {
          const image = this.docker.getImage(img.Id);
          await image.remove({ force: true });
          console.log(`Removed dangling image: ${img.Id}`);
        } catch (err) {
          console.log(`Could not remove dangling image ${img.Id}:`, err.message);
        }
      }

      // Prune system to remove unused data
      try {
        await this.docker.pruneImages({ filters: { dangling: ['true'] } });
        await this.docker.pruneContainers();
        console.log('Pruned unused Docker resources');
      } catch (err) {
        console.log('Could not prune Docker resources:', err.message);
      }

    } catch (err) {
      console.error('Error during smart Docker cleanup:', err);
    }
  }

  async preloadImage() {
    const imageName = 'twaldin/terminal-portfolio:latest';
    console.log(`Preloading Docker image ${imageName} on startup...`);

    try {
      // Wait for Docker to be ready first
      let dockerReady = false;
      let retries = 30;
      while (!dockerReady && retries > 0) {
        try {
          await this.docker.ping();
          dockerReady = true;
          console.log('Connected to Docker daemon');
        } catch (err) {
          console.log(`Waiting for Docker daemon... (${retries} retries left):`, err.message);
          await new Promise(resolve => setTimeout(resolve, 1000));
          retries--;
        }
      }

      if (!dockerReady) {
        console.error('Docker daemon not ready after 30 seconds, skipping preload');
        return;
      }

      // Smart cleanup - keep only the most recent image
      await this.cleanupDockerSmart();

      // Check if image exists locally
      try {
        const images = await this.docker.listImages();
        const imageExists = images.some(img =>
          img.RepoTags && img.RepoTags.includes(imageName)
        );

        if (imageExists) {
          console.log(`Found locally built ${imageName} image`);
          this.imagePreloaded = true;
        } else {
          console.log(`WARNING: ${imageName} not found locally.`);
          this.imagePreloaded = false;
        }
      } catch (err) {
        console.error('Error checking for local image:', err);
        this.imagePreloaded = false;
      }
    } catch (error) {
      console.error(`Error preloading image - will pull on demand:`, error);
      this.imagePreloaded = false;
    }
  }

  async createSession(sessionId, socket, initCommand, clientIP, persistentSessionId) {
    if (this.sessions.size >= this.maxSessions) {
      throw new Error('Maximum session limit reached');
    }

    const pooled = this._grabFromPool();
    if (pooled) {
      // Replenish in the background so subsequent connections stay fast.
      this.fillPool();
      return this.attachPooledSession(sessionId, socket, initCommand, pooled, clientIP, persistentSessionId);
    }
    // Pool was empty — start refilling for the next visitor, then serve this
    // one on the slow path.
    this.fillPool();
    return this.createContainerSession(sessionId, socket, initCommand, clientIP, persistentSessionId);
  }

  async attachPooledSession(sessionId, socket, initCommand, pooled, clientIP, persistentSessionId) {
    console.log(`Assigning pooled container to session ${sessionId}`);

    const { container, stream, buffer } = pooled;

    // Stop the pool-warming handlers; they'd keep appending to .buffer otherwise.
    // _onData may already be null if warmOne() sealed the buffer after welcome ran.
    if (pooled._onData) try { stream.off('data', pooled._onData); } catch { /* ignore */ }
    try { stream.off('close', pooled._onClose); } catch { /* ignore */ }

    // Store the session first so the prompt/output handlers below can reach it.
    const session = {
      id: sessionId,
      type: 'container',
      container,
      stream,
      socket,
      clientIP,
      persistentSessionId,
      startTime: Date.now(),
      lastActivity: Date.now(),
      initCommand,
      // Prompt already rendered during warming — skip straight to the resize gate.
      promptSeen: true,
      firstResizeApplied: false,
      initCommandRun: false,
      inAltScreen: false,
    };
    this.sessions.set(sessionId, session);

    // Replay the buffered prompt output to the client so they see their shell.
    for (const chunk of buffer) socket.emit('output', chunk);

    session._streamDataHandler = (data) => {
      const output = data.toString();
      if (!output.includes('{"stream":true,"stdin":true,"stdout":true,"stderr":true,"hijack":true}')) {
        session.socket.emit('output', output);
        if (output.includes('\x1b[?1049h') || output.includes('\x1b[?47h')) session.inAltScreen = true;
        if (output.includes('\x1b[?1049l') || output.includes('\x1b[?47l')) session.inAltScreen = false;
      }
    };
    stream.on('data', session._streamDataHandler);

    session._streamCloseHandler = () => this._handleStreamClose(session);
    stream.on('close', session._streamCloseHandler);

    // Same 6s fallback as fresh sessions — if the client never sends a resize,
    // unblock initCommand so the session doesn't deadlock.
    setTimeout(() => {
      const s = this.sessions.get(sessionId);
      if (s && !s.firstResizeApplied) {
        console.warn(`Session ${sessionId}: no resize within 6s, releasing initCommand gate`);
        s.firstResizeApplied = true;
        this.maybeRunInitCommand(sessionId);
      }
    }, 6000);

    this.setSessionTimeout(sessionId);
    this.setNoInputTimeout(sessionId);
    console.log(`Session ${sessionId} attached from pool`);
  }

  async createContainerSession(sessionId, socket, initCommand, clientIP, persistentSessionId) {
    console.log(`Creating container session for ${sessionId}`);

    try {
      const imageName = 'twaldin/terminal-portfolio:latest';

      // Check if image exists locally
      let imageExists = false;
      try {
        const images = await this.docker.listImages();
        imageExists = images.some(img =>
          img.RepoTags && img.RepoTags.includes(imageName)
        );
      } catch (err) {
        console.error('Failed to list images:', err);
      }

      if (!imageExists) {
        console.log(`WARNING: ${imageName} not found locally. Container creation may fail.`);
      } else {
        console.log(`Using existing ${imageName} image`);
      }

      // Create Docker container with hardened security
      const container = await this.docker.createContainer({
        Image: imageName,
        Hostname: 'twaldin',
        Tty: true,
        OpenStdin: true,
        StdinOnce: false,
        AttachStdout: true,
        AttachStderr: true,
        AttachStdin: true,
        Env: [
          'TERM=xterm-256color',
          'PS1=tim.waldin.net:$ ',
          // UTF-8 locale so less / cat / pagers treat multi-byte sequences
          // (em-dash, box-drawing chars, nerd-font glyphs) as text rather
          // than printing them as `<E2><80><94>` binary-escapes.
          'LANG=C.UTF-8',
          'LC_ALL=C.UTF-8'
          // NOTE: COLUMNS / LINES intentionally NOT set here. Scripts that
          // read them at startup would render at the wrong size until the
          // first client resize lands (the "tiny nvim until you zoom once"
          // bug). Size comes from the PTY via TIOCGWINSZ once we've applied
          // the first resize from the client — see firstResizeApplied gate.
        ],
        WorkingDir: '/home/portfolio',
        User: 'portfolio',
        Labels: {
          'app': 'terminal-portfolio',
          'session': sessionId
        },
        HostConfig: {
          Memory: 512 * 1024 * 1024, // 512MB limit
          CpuQuota: 50000, // 0.5 CPU limit
          PidsLimit: 100, // Process limit
          ReadonlyRootfs: false, // Need write for nvim plugins
          NetworkMode: 'none', // No network access for security
          CapDrop: ['ALL'],
          CapAdd: ['SETUID', 'SETGID'],
          Tmpfs: {
            '/tmp': 'rw,noexec,nosuid,size=100m'
          }
        }
      });

      // Start container
      await container.start();

      // Pre-resize to a sensible default BEFORE the client resize arrives.
      // Fallback safety-net kicks in at 6s; if it fires, PTY is already at
      // 140x40 instead of docker's 80x24 default — so blog/welcome renders
      // at a usable width even in the worst case. Real client resize arrives
      // shortly after and overrides this.
      try {
        await container.resize({ h: 40, w: 140 });
      } catch (e) {
        console.warn(`Initial pre-resize failed for ${sessionId}:`, e?.message || e);
      }

      // Attach to container
      const stream = await container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true,
        hijack: true
      });

      // Handle container output. The initCommand (welcome / projects / etc)
      // must not fire until BOTH (a) the shell prompt has appeared AND (b) the
      // first resize has been applied to the PTY. Otherwise scripts render
      // figlet boxes / nvim / blog output at the default 80x24 TTY size and
      // the whole screen looks "small until you zoom once". The resizeTerminal
      // handler below flips firstResizeApplied and also drives this gate.

      // Store session (created before handlers so they can reference it)
      const session = {
        id: sessionId,
        type: 'container',
        container: container,
        stream: stream,
        socket: socket,
        clientIP,
        persistentSessionId,
        startTime: Date.now(),
        lastActivity: Date.now(),
        initCommand: initCommand,
        // Gates for running the initCommand: both must be true before we
        // auto-type anything. See stream.on('data') + resizeTerminal.
        promptSeen: false,
        firstResizeApplied: false,
        initCommandRun: false,
        inAltScreen: false,
      };

      this.sessions.set(sessionId, session);

      // Apply any resize that arrived while we were awaiting container creation.
      // Without this, the client's first resize (sent on socket connect, ~16ms)
      // was always dropped because sessions.set hadn't run yet, leaving the
      // 6s fallback to fire at the 140×40 pre-resize size instead of the real
      // viewport dimensions.
      const pendingResize = this.pendingResizes.get(sessionId);
      if (pendingResize) {
        this.pendingResizes.delete(sessionId);
        this.resizeTerminal(sessionId, pendingResize.cols, pendingResize.rows);
      }

      session._streamDataHandler = (data) => {
        const output = data.toString();
        if (!output.includes('{"stream":true,"stdin":true,"stdout":true,"stderr":true,"hijack":true}')) {
          session.socket.emit('output', output);
          // Track whether a TUI app has entered the alternate screen so we
          // can restore xterm.js to the right mode on session reconnect.
          if (output.includes('\x1b[?1049h') || output.includes('\x1b[?47h')) session.inAltScreen = true;
          if (output.includes('\x1b[?1049l') || output.includes('\x1b[?47l')) session.inAltScreen = false;

          const s = this.sessions.get(sessionId);
          if (s && !s.promptSeen && output.includes('~ ')) {
            s.promptSeen = true;
            this.maybeRunInitCommand(sessionId);
          }
        }
      };
      stream.on('data', session._streamDataHandler);

      session._streamCloseHandler = () => this._handleStreamClose(session);
      stream.on('close', session._streamCloseHandler);

      // Safety net: if the client never sends a resize (half-broken client
      // shouldn't deadlock the welcome screen), force the gate open after 6s.
      // 6s covers slow mobile dynamic-import + socket-connect paths where
      // 2s was firing early and init was running at the docker default 80x24.
      // Pre-resize above already put us at 140x40 for this worst case.
      setTimeout(() => {
        const s = this.sessions.get(sessionId);
        if (s && !s.firstResizeApplied) {
          console.warn(`Session ${sessionId}: no resize within 6s, releasing initCommand gate`);
          s.firstResizeApplied = true;
          this.maybeRunInitCommand(sessionId);
        }
      }, 6000);

      // Set session timeouts — 5min idle timer + 60s no-input bot kill.
      this.setSessionTimeout(sessionId);
      this.setNoInputTimeout(sessionId);

      console.log(`Container session created for ${sessionId}`);

    } catch (error) {
      console.error(`Failed to create container for session ${sessionId}:`, error);
      throw error;
    }
  }

  autoTypeCommand(sessionId, command) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (!command || typeof command !== 'string') command = 'welcome';
    // Char whitelist — matches the frontend's SAFE_CMD_RE. Blocks shell
    // metachars (; | & > < ` $ ( ) { } [ ] " ' \ * ? etc).
    if (!/^[a-z0-9 ._/+=:,@-]+$/i.test(command) || command.length > 200) {
      console.warn(`Rejected initCommand for ${sessionId}: ${command} — falling back to welcome`);
      command = 'welcome';
    }

    console.log(`Auto-typing '${command}' for session ${sessionId}`);

    // For `welcome`, type char-by-char so the user sees the command being
    // entered. Other commands get sent atomically (long slugs / blog
    // lookups don't benefit from the animation).
    if (command === 'welcome') {
      try { session.socket.emit('tti', { phase: 'welcome-start' }); } catch { /* ignore */ }
      const chars = [...command];
      const perCharMs = 20;
      chars.forEach((ch, i) => {
        setTimeout(() => {
          if (this.sessions.has(sessionId)) this.sendInput(sessionId, ch);
        }, i * perCharMs);
      });
      setTimeout(() => {
        if (this.sessions.has(sessionId)) {
          this.sendInput(sessionId, '\r');
          try { session.socket.emit('tti', { phase: 'welcome-enter-sent' }); } catch { /* ignore */ }
        }
      }, chars.length * perCharMs + 80);
      return;
    }

    this.sendInput(sessionId, command + '\r');
  }

  sendInput(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.lastActivity = Date.now();
    session.hasReceivedInput = true;
    // Cancel the no-input bot-kill timer on the first real keystroke.
    if (session.noInputTimer) {
      clearTimeout(session.noInputTimer);
      session.noInputTimer = null;
    }
    // Resetting the main 5-min idle timer keeps active users alive.
    this.setSessionTimeout(sessionId);
    session.stream.write(data);
  }

  resizeTerminal(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      // Session still being created (fresh container path has multiple awaits
      // before sessions.set). Buffer the latest resize so we can apply it the
      // moment the session is stored rather than waiting for the 6s fallback.
      this.pendingResizes.set(sessionId, { cols, rows });
      return;
    }

    // Resize is passive — don't count as activity and don't reset timers.
    session.container.resize({
      h: rows,
      w: cols
    }).then(() => {
      if (!session.firstResizeApplied) {
        session.firstResizeApplied = true;
        this.maybeRunInitCommand(sessionId);
      }
    }).catch((error) => {
      console.error(`Failed to resize container terminal for ${sessionId}:`, error);
      // Container is gone (e.g. killed externally). Destroy the session so the
      // client gets session_end → auto-reconnect → fresh container.
      if (error?.statusCode === 404) {
        this.destroySession(sessionId);
      }
    });
  }

  // Shared stream-close handler — called whether the session is still live or
  // has been zombified. Covers the gap where a container dies after zombification:
  // destroySession can't find the session in sessions.map (already moved to
  // zombieSessions), so without this, the dead zombie persists until the 30s
  // grace timer fires and a reconnect gets the blank-cursor experience.
  _handleStreamClose(session) {
    const currentId = session.id;
    console.log(`Container stream closed for session ${currentId}`);
    if (this.sessions.has(currentId)) {
      this.destroySession(currentId);
    } else {
      for (const [ip, zombie] of this.zombieSessions.entries()) {
        if (zombie.session === session) {
          console.log(`Zombie container stream closed, cleaning up for IP ${ip}`);
          clearTimeout(zombie.graceTimer);
          this.zombieSessions.delete(ip);
          this._killSession(session);
          break;
        }
      }
    }
  }

  // Run the initCommand only once both the shell prompt has appeared AND the
  // first client resize has been applied to the PTY. This avoids rendering
  // welcome / nvim / blog at the default TTY size before the real viewport
  // dimensions are known.
  maybeRunInitCommand(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.initCommandRun) return;
    if (!session.promptSeen || !session.firstResizeApplied) return;

    // Empty-string initCommand is a deliberate "no-op" sentinel used by the
    // blog cold page when it hands over to a live session — the page already
    // shows blog content + user has typed, so we don't want to overwrite
    // their input with a canned welcome/command run.
    if (session.initCommand === '') {
      session.initCommandRun = true;
      return;
    }

    session.initCommandRun = true;
    const cmd = session.initCommand || 'welcome';
    console.log(`Session ${sessionId}: prompt+resize ready, auto-typing '${cmd}'`);
    // 20ms settling delay — gives xterm one frame to finish
    // rendering the resize before command output starts streaming in.
    setTimeout(() => this.autoTypeCommand(sessionId, cmd), 20);
  }

  restoreByPersistentSessionId(persistentSessionId, newSocketId, newSocket, clientIP, initCommand) {
    if (!persistentSessionId) return null;

    // On refresh / new-tab, xterm.js has no scrollback from the previous
    // browser session, so we re-run the URL's initCommand in the existing
    // container to repaint the welcome / projects / etc output. The user
    // gets session persistence (container kept warm) plus a fresh render.
    const rerunInitCommand = (sid) => {
      if (!initCommand && initCommand !== '') return;
      const s = this.sessions.get(sid);
      if (!s) return;

      // If a TUI app (nvim, htop, etc.) is running in the alt screen, do NOT
      // send Ctrl-C (it doesn't exit nvim — it just rings the bell), and do
      // NOT type the initCommand (it'd be sent as keystrokes into the running
      // app). Just reset firstResizeApplied so the incoming resize triggers
      // SIGWINCH, which causes the app to redraw at the correct size.
      if (s.inAltScreen) {
        s.firstResizeApplied = false;
        return;
      }

      s.initCommand = initCommand;
      s.initCommandRun = false;
      s.firstResizeApplied = false;
      // NOTE: do NOT reset hasPrompt. The container shell has already been
      // sitting at a prompt from the prior session; the prompt-detector in
      // the stream data handler only flips the flag on NEW prompt emissions.
      // If we reset it, maybeRunInitCommand waits forever, the client
      // eventually types into a stale prompt, and the autotyped `projects`
      // interleaves with whatever output was mid-flight — producing the
      // "zsh path line appears mid-script" artifact.
      //
      // Instead, send a Ctrl-C first to cancel any script that was still
      // running when the previous socket disconnected, then let the first
      // resize from the new client trigger maybeRunInitCommand. Any
      // half-finished `projects` / `welcome` stream from before is aborted
      // cleanly rather than interleaved with the fresh run.
      try { this.sendInput(sid, '\x03'); } catch { /* ignore */ }
    };

    for (const [existingSocketId, session] of this.sessions.entries()) {
      if (session.persistentSessionId !== persistentSessionId) continue;
      if (existingSocketId === newSocketId) return { type: 'active', oldSocketId: existingSocketId };

      this.sessions.delete(existingSocketId);
      session.id = newSocketId;
      session.socket = newSocket;
      session.clientIP = clientIP;
      session.lastActivity = Date.now();

      // Restore alt-screen mode on the new xterm.js before any container
      // output arrives. Without this, nvim (still in alt screen on the
      // container side) redraws without re-sending \033[?1049h, so its
      // content lands on xterm.js's main screen and produces ghost artifacts
      // when oil or another TUI subsequently redraws differentially.
      if (session.inAltScreen) {
        newSocket.emit('output', '\x1b[?1049h\x1b[2J\x1b[H');
      }

      this.sessions.set(newSocketId, session);
      this.setSessionTimeout(newSocketId);
      this.setNoInputTimeout(newSocketId);

      rerunInitCommand(newSocketId);

      return { type: 'active', oldSocketId: existingSocketId };
    }

    for (const [ip, zombie] of this.zombieSessions.entries()) {
      const { session, graceTimer } = zombie;
      if (session.persistentSessionId !== persistentSessionId) continue;

      clearTimeout(graceTimer);
      this.zombieSessions.delete(ip);

      session.id = newSocketId;
      session.socket = newSocket;
      session.clientIP = clientIP;
      session.lastActivity = Date.now();

      if (session._streamDataHandler) {
        session.stream.off('data', session._streamDataHandler);
      }
      session._streamDataHandler = (data) => {
        const output = data.toString();
        if (!output.includes('{"stream":true,"stdin":true,"stdout":true,"stderr":true,"hijack":true}')) {
          session.socket.emit('output', output);
          if (output.includes('\x1b[?1049h') || output.includes('\x1b[?47h')) session.inAltScreen = true;
          if (output.includes('\x1b[?1049l') || output.includes('\x1b[?47l')) session.inAltScreen = false;
        }
      };
      session.stream.on('data', session._streamDataHandler);

      // Same alt-screen restore as the active-session path above.
      if (session.inAltScreen) {
        newSocket.emit('output', '\x1b[?1049h\x1b[2J\x1b[H');
      }

      this.sessions.set(newSocketId, session);
      this.setSessionTimeout(newSocketId);
      this.setNoInputTimeout(newSocketId);

      rerunInitCommand(newSocketId);

      return { type: 'zombie' };
    }

    return null;
  }

  async destroySession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    console.log(`Destroying session ${sessionId}`);

    // Tell the client the session is gone so it clears its persistent session
    // ID and gets a fresh container on next load. Without this, localStorage
    // keeps the old ID, zombie reattach finds nothing after 30s, and the user
    // silently gets a fresh container — but only if they waited long enough.
    // "exit" + refresh should reliably give a new terminal, not a maybe.
    try {
      session.socket.emit('output', '\r\n\x1b[2m[session ended — refresh for a new terminal]\x1b[0m\r\n');
      session.socket.emit('session_end');
    } catch { /* socket may already be gone */ }

    try {
      if (session.stream) {
        session.stream.end();
      }

      if (session.container) {
        await session.container.kill().catch(() => {});
        await session.container.remove({ force: true }).catch(() => {});
      }

      // Clear both timers
      if (session.timeout) clearTimeout(session.timeout);
      if (session.noInputTimer) clearTimeout(session.noInputTimer);

      this.sessions.delete(sessionId);
      console.log(`Session ${sessionId} destroyed`);

    } catch (error) {
      console.error(`Error destroying session ${sessionId}:`, error);
      this.sessions.delete(sessionId);
    }
  }

  tryReattach(clientIP, newSocketId, newSocket) {
    const zombie = this.zombieSessions.get(clientIP);
    if (!zombie) return null;

    const { session, graceTimer } = zombie;
    clearTimeout(graceTimer);
    this.zombieSessions.delete(clientIP);

    // Swap socket
    session.id = newSocketId;
    session.socket = newSocket;

    // Swap stream data handler to emit to new socket
    if (session._streamDataHandler) {
      session.stream.off('data', session._streamDataHandler);
    }
    session._streamDataHandler = (data) => {
      const output = data.toString();
      if (!output.includes('{"stream":true,"stdin":true,"stdout":true,"stderr":true,"hijack":true}')) {
        session.socket.emit('output', output);
        if (output.includes('\x1b[?1049h') || output.includes('\x1b[?47h')) session.inAltScreen = true;
        if (output.includes('\x1b[?1049l') || output.includes('\x1b[?47l')) session.inAltScreen = false;
      }
    };
    session.stream.on('data', session._streamDataHandler);

    // Restore alt-screen mode on the new xterm.js before container output
    // arrives so nvim's SIGWINCH redraw goes to the right buffer.
    if (session.inAltScreen) {
      newSocket.emit('output', '\x1b[?1049h\x1b[2J\x1b[H');
    }

    session.initCommandRun = true;
    session.hasReceivedInput = false;
    session.lastActivity = Date.now();

    this.sessions.set(newSocketId, session);
    this.setSessionTimeout(newSocketId);
    this.setNoInputTimeout(newSocketId);

    console.log(`Reattached session ${newSocketId} (was zombie from IP ${clientIP})`);
    return session;
  }

  zombifySession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.sessions.delete(sessionId);

    if (session.timeout) clearTimeout(session.timeout);
    if (session.noInputTimer) clearTimeout(session.noInputTimer);

    const clientIP = session.clientIP;
    if (!clientIP) {
      this._killSession(session);
      return;
    }

    // If there's already a zombie for this IP, kill it first
    const existing = this.zombieSessions.get(clientIP);
    if (existing) {
      clearTimeout(existing.graceTimer);
      this._killSession(existing.session);
    }

    const graceTimer = setTimeout(() => {
      const z = this.zombieSessions.get(clientIP);
      if (z) {
        this.zombieSessions.delete(clientIP);
        this._killSession(z.session);
      }
    }, 30000);

    this.zombieSessions.set(clientIP, { session, graceTimer });
    console.log(`Session ${sessionId} zombified (30s grace for IP ${clientIP})`);
  }

  _killSession(session) {
    try {
      if (session.stream) session.stream.end();
      if (session.container) {
        session.container.kill().catch(() => {});
        session.container.remove({ force: true }).catch(() => {});
      }
    } catch (error) {
      console.error(`Error killing session ${session.id}:`, error);
    }
  }

  async destroyAllSessions() {
    console.log('Destroying all sessions...');
    const promises = Array.from(this.sessions.keys()).map(sessionId =>
      this.destroySession(sessionId)
    );
    await Promise.all(promises);
    console.log('All sessions destroyed');
  }

  setSessionTimeout(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.timeout) {
      clearTimeout(session.timeout);
    }

    session.timeout = setTimeout(() => {
      console.log(`Session ${sessionId} timed out (idle ${this.sessionTimeout / 1000}s)`);
      const { socket } = session;
      this.destroySession(sessionId);
      if (socket) {
        socket.emit('output', '\r\n[session idle — closed]\r\n');
        socket.disconnect();
      }
    }, this.sessionTimeout);
  }

  // Bot / background-tab killer: if the session receives NO user input at all
  // within `noInputTimeout`, assume it's not an engaged user and free the slot.
  // Cancelled on the first sendInput().
  setNoInputTimeout(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.noInputTimer) clearTimeout(session.noInputTimer);

    session.noInputTimer = setTimeout(() => {
      const s = this.sessions.get(sessionId);
      if (!s || s.hasReceivedInput) return;
      console.log(`Session ${sessionId} closed (no user input within ${this.noInputTimeout / 1000}s)`);
      const { socket } = s;
      this.destroySession(sessionId);
      if (socket) {
        try { socket.disconnect(); } catch { /* ignore */ }
      }
    }, this.noInputTimeout);
  }

  getActiveSessionCount() {
    return this.sessions.size;
  }

  getTotalContainerCount() {
    return this.sessions.size;
  }

  // Cleanup orphaned containers periodically
  async cleanupOrphanedContainers() {
    try {
      const containers = await this.docker.listContainers({
        all: true,
        filters: {
          label: ['app=terminal-portfolio']
        }
      });

      for (const containerInfo of containers) {
        const container = this.docker.getContainer(containerInfo.Id);

        const isActive = Array.from(this.sessions.values()).some(
          session => session.container && session.container.id === containerInfo.Id
        );
        const isPooled = this.pool.some((p) => p.container.id === containerInfo.Id);

        if (!isActive && !isPooled) {
          console.log(`Cleaning up orphaned container: ${containerInfo.Id}`);
          await container.kill().catch(() => {});
          await container.remove({ force: true }).catch(() => {});
        }
      }
    } catch (error) {
      console.error('Error cleaning up orphaned containers:', error);
    }
  }
}

module.exports = SessionManager;
