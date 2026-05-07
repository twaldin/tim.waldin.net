# backend/

Node.js 18 + Express + Socket.IO server (`server.js`) and a `SessionManager` (`session.js`) that wraps `dockerode` to manage per-visitor Ubuntu containers. Talks to the Docker API through `tecnativa/docker-socket-proxy` over `tcp://socket-proxy:2375` — never to a raw `/var/run/docker.sock`.

## Files

- **`server.js`** — Express app, Socket.IO server, CORS allowlist, per-IP rate limit, IP→sessionId map, command-buffer audit logger, graceful shutdown.
- **`session.js`** — `SessionManager` class. Container pool, lease/attach, persistent-session reattach, zombie/grace, idle timers, orphan cleanup, image preload.
- **`admin.js`** — basic-auth-protected `/admin` router (`ADMIN_EMAIL` / `ADMIN_PASSWORD` from env, surfaces session/log views).
- **`logger.js`** — JSONL audit log to `backend_data` volume (`session_start`, `session_end`, `command` events).

## Runtime model: pre-warmed pool, IP-pinned sessions

- **Pool**: 5 warm containers kept ready (`poolSize`, `session.js:31`). On lease, the pool is replenished in the background. Pool warm-up runs `welcome` once during build to populate the figlet/OMP cache so the first visitor sees instant output.
- **Hard cap**: 40 concurrent sessions (`maxSessions`, `session.js:17`). Beyond that, `createSession` throws and the client gets `error: 'Failed to create terminal session'`.
- **Single session per IP**: `ipSessions: Map<ip, socketId>` in `server.js:54`. A new connection from an IP that already has a session sends `[replaced by a new session from this ip]` to the old socket, disconnects it, destroys the old session, then takes the slot (`server.js:116-131`).
- **Persistent sessionId path**: if the client's handshake auth includes a `sessionId` (UUID stored client-side in `localStorage`), `restoreByPersistentSessionId` (`session.js:677`) reattaches the existing container instead of creating a new one. If the existing session is on a different socket, the old socket gets `[session continued in a new tab]` and is disconnected — the container itself is reused (`server.js:99-110`). Refresh in the same tab takes this path.
- **Zombie reconnect**: on socket disconnect (browser close, network blip), `zombifySession` (`session.js:871`) keeps the container alive in `zombieSessions: Map<ip, {session, graceTimer}>` for **30 seconds**. A reconnect from the same IP within that window reattaches via `tryReattach` (`session.js:827`). After 30s the grace timer fires and the container is killed.

## Idle / bot timers (`session.js`)

| Timer                     | Field             | Reset on              | Action |
|---------------------------|-------------------|-----------------------|--------|
| `sessionTimeout` (5 min)  | `session.timeout` | `sendInput`           | kill session, emit `[session idle — closed]` |
| `noInputTimeout` (60 s)   | `session.noInputTimer` | first `sendInput` (cancels) | kill session if no keystrokes ever arrived |
| Connection rate limit     | `connectionTracker` | sliding 60 s window | reject if >30 connects/min from one IP (`server.js:47`) |

Resize is a passive signal — it does **not** reset `sessionTimeout` (`session.js:608` comment).

## Container spec (`session.js:46`)

`twaldin/terminal-portfolio:latest`, non-root `portfolio` user, `NetworkMode: none`, `CapDrop: ALL` plus `CapAdd: SETUID, SETGID` (so the container's `sudo` demo works), 512 MB RAM, 0.5 CPU, `PidsLimit: 100`, `tmpfs /tmp` (rw, noexec, nosuid, 100m). `LANG=C.UTF-8 / LC_ALL=C.UTF-8` so multi-byte glyphs render in `less` / `cat`.

`COLUMNS` / `LINES` are deliberately **not** set in `Env`. Scripts that read them at startup would render at 80×24 until the first client resize lands; instead we gate `initCommand` on both `promptSeen` and `firstResizeApplied` (`maybeRunInitCommand`, `session.js:654`) so figlet/nvim/blog never render at the wrong size.

## Boot sequence for a new visitor

1. Socket connects with optional `auth.sessionId` (persistent UUID) and `auth.initCommand` (URL-derived).
2. `checkRateLimit(ip)` → reject if exceeded.
3. If `sessionId` matches an existing session/zombie → `restoreByPersistentSessionId`, slot taken.
4. Else if `ipSessions` already has this IP → kick the old socket+container, then create a fresh session.
5. `createSession` → `_grabFromPool()` if available; else `createContainerSession` (slow path).
6. Wait for `promptSeen` (zsh prompt rendered) AND `firstResizeApplied` (client sent dimensions). 6-second fallback releases the gate at the pre-resize 140×40 dimensions.
7. Auto-type the `initCommand` (default `welcome`) char-by-char for `welcome` (animated), atomically for everything else (`autoTypeCommand`, `session.js:545`).

## InitCommand validation

`autoTypeCommand` re-validates the command using the same regex/heads list as the frontend: `/^[a-z0-9 ._/+=:,@-]+$/i`, length ≤ 200. Anything that fails falls back to `welcome` rather than rejecting outright.

## Orphan cleanup

`cleanupOrphanedContainers` runs every 60 s (`server.js:227`). Lists all containers with label `app=terminal-portfolio`, kills any that aren't in the live `sessions` map and aren't in the warm `pool`. On startup, `cleanupDockerSmart` removes leftover portfolio containers from the previous backend run plus all but the newest portfolio image.

## Things to watch

- `_handleStreamClose` (`session.js:632`) covers both live and zombified sessions. Without it, a container that dies after zombification would persist until the 30s timer fires and a reconnect would land in a blank session.
- `inAltScreen` tracking (`\x1b[?1049h/l` and `\x1b[?47h/l`) is required for nvim/htop reattach: on socket swap we re-emit the alt-screen-enter sequence to the new xterm.js so the redraw lands in the right buffer.
- The pool's data handler is detached during welcome warm-up to avoid prompt bleed (`session.js:152`); on lease, the buffered prompt is replayed but new output goes through `session._streamDataHandler`.
- Don't add EXEC to the socket-proxy env. The lease path doesn't need it; enabling it would expose `docker exec` to a compromised backend.
