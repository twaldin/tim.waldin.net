# tim.waldin.net (term-site)

Interactive terminal-themed portfolio at [tim.waldin.net](https://tim.waldin.net). Visitors land on a web-based xterm.js terminal that connects via Socket.IO to a Node.js backend, which leases them an isolated Ubuntu Docker container running a custom zsh shell with portfolio scripts (figlet ASCII art, project pages, blog, resume).

## Three layers

```
Browser                Server                       Sandbox
─────────────          ──────────────               ─────────────────
Next.js 15 +    ──→    Nginx (TLS, rate-limit) ──→  Docker container
xterm.js 5.5    ←──    Express + Socket.IO     ←──  per visitor IP
                       dockerode → socket-proxy     (zsh + scripts)
```

- **`frontend/`** — Next.js 15 / React 19 app. Renders xterm.js with Gruvbox Dark + JetBrainsMono Nerd Font, a Socket.IO client, and a URL ↔ command sync layer (typing `projects` updates the URL to `/projects/...`; visiting `/blog/<slug>` auto-types `blog <slug>`). See `frontend/CLAUDE.md`.
- **`backend/`** — Node.js + Express + Socket.IO + dockerode. Manages a pre-warmed pool of containers, leases one per visitor IP, handles input/output streaming, resize, idle/no-input timeouts, zombie-reconnect, and admin auth. See `backend/CLAUDE.md`.
- **`container/`** — Ubuntu 24.04 image (`twaldin/terminal-portfolio:latest`) with zsh, Oh My Posh, neovim (nightly via bob), figlet/mdcat/glow, and `scripts/*.sh` for the portfolio (welcome, projects, blog, resume, contact, etc.). See `container/CLAUDE.md`.

## Runtime model: pre-warmed pool + IP-pinned sessions

The backend keeps **5 warm containers** ready (`SessionManager.poolSize`, `backend/session.js:31`) so new connections skip the 1–2s `createContainer` latency. Hard cap of **40 concurrent sessions** (`maxSessions`, `backend/session.js:17`).

Each visitor IP holds **one live session at a time**. A new Socket.IO connection from the same IP immediately closes the old one — see `ipSessions` map in `backend/server.js:54` and the kick logic in `backend/server.js:116-131`. Concretely:

- Open a second tab from the same IP → the old tab's session is collapsed into the new tab (old socket gets `[replaced by a new session from this ip]` and disconnects). The container is reused only when the new tab presents the same `localStorage` `sessionId` (persistent-session restore, `backend/session.js:677`); otherwise the old container is destroyed and a fresh one is leased.
- Refresh the same tab → the persistent `sessionId` is sent in the Socket.IO handshake auth, the existing container is reattached, the URL's `initCommand` is re-run so the visible output repaints. Backend rule of thumb: *one IP = one slot*.
- Type `exit` → container is killed, slot is freed.

Disconnect without `exit` (browser close, network drop) → session is **zombified** with a 30s grace window (`zombifySession`, `backend/session.js:871`) so a quick reconnect from the same IP/sessionId can reattach without losing shell state.

Idle / bot timers, all in `backend/session.js`:

- **5 min idle** without keystrokes → kill (`sessionTimeout`, line 21).
- **60 s no-input** from connect → kill (`noInputTimeout`, line 24) — kills bots and background tabs that never engage.
- **30 connection attempts/min per IP** rate-limit at the Socket.IO layer (`backend/server.js:47`).

## Sandbox / security

- Each session container runs as non-root `portfolio` user with `CapDrop: ALL` (only `SETUID/SETGID` re-added for sudo demo), `NetworkMode: none`, `PidsLimit: 100`, 512 MB RAM, 0.5 CPU, `tmpfs /tmp` (noexec, nosuid). Spec: `backend/session.js:46`. Visitors can run `sudo rm -rf /` or fork-bombs — only their own container is affected, never the host.
- `tecnativa/docker-socket-proxy` exposes the Docker API to the backend over `tcp://socket-proxy:2375` with a strict allowlist: `CONTAINERS=1, IMAGES=1, POST=1` and everything else (`NETWORKS, VOLUMES, BUILD, EXEC, SERVICES, SWARM`) disabled. The backend never gets a raw `/var/run/docker.sock`. See `docker-compose.yml:40-62`.

## Deployment shape

`docker-compose.yml` brings up four services on three internal Docker networks plus one external bridge:

| Service        | Image / build                          | Network                     |
|----------------|----------------------------------------|-----------------------------|
| `nginx`        | `nginx:alpine` + `nginx.conf`          | external + frontend + backend |
| `frontend`     | `frontend/Dockerfile.production`        | frontend (internal)         |
| `backend`      | `backend/Dockerfile`                    | backend + docker (internal) |
| `socket-proxy` | `tecnativa/docker-socket-proxy`         | docker (internal)           |

Nginx terminates TLS via Let's Encrypt (`/etc/letsencrypt` mounted read-only), enforces global rate limits (10 r/s, burst 20), proxies `/socket.io/` with WebSocket upgrade, caches `/fonts/` aggressively, and blocks the Next.js CVE-2025-29927 middleware-bypass header. Session containers themselves are spawned dynamically by the backend on the host's default bridge — they're not declared in compose.

`deploy.sh` is the production deploy entry point.

## Local dev

- `cd frontend && pnpm dev` (Next 15 with Turbopack, port 3000).
- `cd backend && npm start` (port 3001; needs `DOCKER_HOST` or a local docker socket).
- For a full local stack: `docker compose -f docker-compose.local.yml up`.
- The container image is built with `container/build.sh` → tags `twaldin/terminal-portfolio:latest`. The backend looks up the image by exact tag in `backend/session.js:240` and warns if it's missing locally.

## Pointers

- **`frontend/CLAUDE.md`** — Terminal component, dynamic font sizing, OSC 8 / OSC 9999 URL sync, Socket.IO handshake, blog static pages.
- **`backend/CLAUDE.md`** — Session lifecycle, pool warming, IP-pinned session + tab-collapse, zombie reconnect, admin panel.
- **`container/CLAUDE.md`** — Dockerfile shape, portfolio scripts, Oh My Posh prompt, baked-in nvim plugins, OSC URL emit hook in zshrc.

## Conventions

- Every directory with a `CLAUDE.md` also has an `AGENTS.md` symlink → `CLAUDE.md`. Treat `CLAUDE.md` as canonical; edit only `CLAUDE.md`, never `AGENTS.md`.
- Diagnosis scratch files at the repo root (`MOBILE-RENDER-DIAGNOSIS.md`, `TTI-DIAGNOSIS.md`) are historical investigation notes, not authoritative docs.

<!-- flt:start -->
# Fleet Agent: writer-term
You are a managed subagent in a fleet orchestrated by flt.
Parent agent: project-convs-grill | CLI: claude-code | Model: opus[1m]

## communication
- Parent is another agent. Send progress/questions via `flt send parent "..."`.
- Use parent as the primary coordination channel.
- `flt send parent "..."` — in-scope status, blockers, completion. Default channel.
- `flt ask oracle "<question>" --from writer-term` — out-of-scope research, second opinions, ambiguous design choices. Reply lands in your inbox, not the human's.
- Do NOT message the human directly. Parent or oracle, never human.

## flt quick commands
- send message: `flt send <agent|parent> "message"`
- ask oracle: `flt ask oracle "<question>" --from writer-term`
- list agents: `flt list`
- view logs: `flt logs <name>`

## handoffs
- If you produce a candidate output (summary, plan, diff, eval), write it to `$FLT_RUN_DIR/handoffs/<your-name>.md` when `$FLT_RUN_DIR` is set. `collect_artifacts` steps preserve this file across worktree teardown.

## skills
- No skills loaded for this run. Skills are opt-in at spawn.

## protocol
- Report completion and blockers quickly.
- Do not modify this flt instruction block.


# Architect

Take a spec and produce an implementation plan. You don't code — you design. Your job is to make the coder's job mechanical.

## Responsibilities

Read `$FLT_RUN_DIR/artifacts/spec.md` and `acceptance.md`, then inspect the existing repo (file structure, naming patterns, current tests, existing utilities to reuse). Produce in `$FLT_RUN_DIR/artifacts/`:

- `design.md` — implementation approach, key types/interfaces, control flow, fallback behavior. Reference existing code by `path:line` when reusing.
- `files_to_touch.md` — bullet list of every file likely to be created/modified. Mark "create" vs "modify".
- `test_plan.md` — which tests to write/update and at which boundary (unit/integration/e2e).
- `risk_register.md` — non-obvious failure modes, race conditions, security-sensitive paths, scope creep risks.

## Comms

- Parent receives `flt send parent "design done: <files-touched-count>, <risks-flagged-count>"`.
- For library/API choices you're uncertain about, `flt ask oracle '<question>'` first.
- Never message the human directly.

## Guardrails

- Inspect actual code before designing. Grep the repo. Read existing files. Do not design against assumed structure.
- Prefer reusing existing utilities over inventing new abstractions.
- No premature abstraction. Three similar lines is fine; a generalized helper for two callers is not.
- If the spec is contradictory or impossible against the existing repo, raise it as a blocker via `flt send parent "blocked: <reason>"` and stop.

<!-- flt:end -->
