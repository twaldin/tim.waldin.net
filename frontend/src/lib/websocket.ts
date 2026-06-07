import { io, Socket } from 'socket.io-client';

// Whitelist of top-level commands any URL path can launch on connect. The
// backend also re-validates (characters, length) as a second line of defense.
// Legacy pretty URL: /projects/<alias> jumps straight into the project
// (runs the alias command, which cd's + shows the project info page).
const PROJECT_ALIASES = new Set([
  'flt', 'agentelo', 'trade-up-bot', 'skyblock-qol',
  'term-site', 'stm32-games', 'dotfiles', 'hone', 'harness',
]);

// Commands that must never be triggered from a URL, even with a clean char
// set. The container is already sandboxed (non-root, no-net, cap-drop, ephemeral)
// but a drive-by `/rm%20-rf%20~` is still annoying for the visitor's session.
const BLOCKED_HEADS = new Set([
  'rm', 'mv', 'cp', 'dd', 'sudo', 'su', 'chmod', 'chown',
  'kill', 'pkill', 'killall', 'sh', 'bash', 'zsh', 'dash',
  'eval', 'exec', 'source', 'mkfs', 'mount', 'umount',
  'exit', 'logout', // would auto-type and immediately end the session
]);

// Safe char set for a full command string (first word + args combined).
// Blocks shell metachars: ; | & > < ` $ ( ) { } [ ] * ? ! ~ ^ " ' \
const SAFE_CMD_RE = /^[A-Za-z0-9 ._/+=:,@-]+$/;

function pathToCommand(pathname: string): string | undefined {
  let clean = pathname.replace(/^\/+|\/+$/g, '');
  if (!clean) return 'welcome'; // '/' → always run welcome (also ensures restore reruns it)
  // /t/<command> prefix forces live terminal (used by static blog pages)
  if (clean.startsWith('t/')) clean = clean.slice(2);

  // Legacy pretty URL: /projects/<alias> → just <alias>. Lets old links
  // keep working after we switched to universal command sync.
  const legacy = clean.match(/^projects\/([a-z0-9._-]+)$/i);
  if (legacy && PROJECT_ALIASES.has(legacy[1])) {
    return legacy[1];
  }

  // Universal: decode the URL, verify it parses to a safe command, return
  // it verbatim. Spaces in the user's command are encoded as %20 in the
  // URL; path-like args keep their `/` characters literally.
  let cmd: string;
  try {
    cmd = decodeURIComponent(clean);
  } catch { return undefined; }
  if (cmd.length > 200) return undefined;
  if (!SAFE_CMD_RE.test(cmd)) return undefined;
  // If the URL was typed as `/blog/<slug>` (no space), convert the first
  // `/` to a space so it runs as `blog <slug>` — people share URLs with
  // `/` separators, not %20.
  if (!/\s/.test(cmd) && cmd.includes('/')) {
    cmd = cmd.replace('/', ' ');
  }
  const head = cmd.split(/\s+/)[0];
  if (BLOCKED_HEADS.has(head)) return undefined;
  return cmd;
}

export interface WebSocketManager {
  socket: Socket | null;
  connect: () => void;
  disconnect: () => void;
  sendInput: (data: string) => void;
  onOutput: (callback: (data: string) => void) => void;
  onConnect: (callback: () => void) => void;
  onDisconnect: (callback: () => void) => void;
  onError: (callback: (error: Error) => void) => void;
  onTti: (callback: (phase: string) => void) => void;
  onSessionEnd: (callback: () => void) => void;
  onSessionStatus: (callback: (status: { mode?: 'cold' | 'resume'; restoredType?: 'active' | 'zombie' }) => void) => void;
  resize: (cols: number, rows: number) => void;
}

export function createWebSocketManager(): WebSocketManager {
  let socket: Socket | null = null;
  let connectCallback: (() => void) | null = null;
  let disconnectCallback: (() => void) | null = null;
  let errorCallback: ((error: Error) => void) | null = null;
  let outputCallback: ((data: string) => void) | null = null;
  let ttiCallback: ((phase: string) => void) | null = null;
  let sessionEndCallback: (() => void) | null = null;
  let sessionStatusCallback: ((status: { mode?: 'cold' | 'resume'; restoredType?: 'active' | 'zombie' }) => void) | null = null;

  // Generate or reuse persistent session ID
  const getSessionId = (): string => {
    if (typeof window === 'undefined') return `session-${Date.now()}`;

    let sessionId = localStorage.getItem('terminal-session-id');
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      localStorage.setItem('terminal-session-id', sessionId);
    }
    return sessionId;
  };
  // Buffer the most recent resize so we can re-emit it once the socket connects.
  // Without this, the xterm fit on mount (at 100/200ms) fires before socket is
  // ready, we drop the emit, and the PTY stays at default 80x24 until the user
  // triggers another browser-side resize (zoom, window resize).
  let lastResize: { cols: number; rows: number } | null = null;

  const getWebSocketUrl = (): string => {
    if (process.env.NEXT_PUBLIC_API_URL) {
      return process.env.NEXT_PUBLIC_API_URL;
    }
    if (typeof window !== 'undefined') {
      return `${window.location.protocol}//${window.location.host}`;
    }
    return 'http://localhost:3001';
  };

  const connect = () => {
    if (socket?.connected) return;

    const initCommand = typeof window !== 'undefined' ? pathToCommand(window.location.pathname) : undefined;
    const sessionId = getSessionId();

    socket = io(getWebSocketUrl(), {
      // websocket-first: skip the polling handshake on browsers that support WS
      // (essentially all of them). Falls back to polling if WS fails.
      transports: ['websocket'],
      timeout: 5000, // Reduce timeout for faster TTI
      reconnection: false, // Disable reconnection for faster initial connect
      forceNew: false, // Don't force new connection to allow reattach
      upgrade: true,
      rememberUpgrade: true,
      auth: {
        initCommand,
        sessionId // Send persistent session ID
      },
    });

    socket.on('connect', () => {
      // Flush any resize that was emitted before the socket became ready so
      // the container PTY gets sized correctly on first render (not just
      // after a browser zoom/resize).
      if (lastResize) socket?.emit('resize', lastResize);
      connectCallback?.();
    });

    socket.on('session_status', (status: { mode?: 'cold' | 'resume'; restoredType?: 'active' | 'zombie' }) => {
      sessionStatusCallback?.(status);
    });

    socket.on('disconnect', () => {
      disconnectCallback?.();
    });

    socket.on('connect_error', (error) => {
      errorCallback?.(error);

      setTimeout(() => {
        if (socket && !socket.connected) {
          socket.connect();
        }
      }, 3000);
    });

    socket.on('reconnect_failed', () => {
      errorCallback?.(new Error('Reconnection failed'));
    });

    socket.on('output', (data) => {
      outputCallback?.(data);
    });

    socket.on('tti', (payload: { phase?: string }) => {
      if (typeof payload?.phase === 'string') {
        ttiCallback?.(payload.phase);
      }
    });

    socket.on('session_end', () => {
      // Container exited (e.g. user typed 'exit'). Clear the persistent session
      // ID so the next reconnect gets a fresh container.
      if (typeof window !== 'undefined') {
        localStorage.removeItem('terminal-session-id');
      }
      sessionEndCallback?.();
      // Disconnect so the caller can call connect() again for a fresh session.
      socket?.disconnect();
      socket = null;
    });
  };

  const disconnect = () => {
    if (socket) {
      // Don't disconnect immediately on refresh to allow zombie reattach
      // Only disconnect when user explicitly closes the tab
      if (!window.performance.navigation?.type || window.performance.navigation.type !== 0) {
        socket.disconnect();
      }
      socket = null;
    }
  };

  const sendInput = (data: string) => {
    if (socket?.connected) {
      socket.emit('input', data);
    }
  };

  const onOutput = (callback: (data: string) => void) => {
    outputCallback = callback;
  };

  const onConnect = (callback: () => void) => {
    connectCallback = callback;
  };

  const onDisconnect = (callback: () => void) => {
    disconnectCallback = callback;
  };

  const onError = (callback: (error: Error) => void) => {
    errorCallback = callback;
  };

  const onTti = (callback: (phase: string) => void) => {
    ttiCallback = callback;
  };

  const onSessionEnd = (callback: () => void) => {
    sessionEndCallback = callback;
  };

  const onSessionStatus = (callback: (status: { mode?: 'cold' | 'resume'; restoredType?: 'active' | 'zombie' }) => void) => {
    sessionStatusCallback = callback;
  };

  const resize = (cols: number, rows: number) => {
    lastResize = { cols, rows };
    if (socket?.connected) {
      socket.emit('resize', lastResize);
    }
  };

  return {
    get socket() { return socket; },
    connect,
    disconnect,
    sendInput,
    onOutput,
    onConnect,
    onDisconnect,
    onError,
    onTti,
    onSessionEnd,
    onSessionStatus,
    resize,
  };
}
