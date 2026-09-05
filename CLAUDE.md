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

- **`frontend/`** — Next.js 15 / React 19 app. Renders xterm.js with JetBrainsMono Nerd Font and 463 Ghostty themes (`src/config/themes.ts`, defaults `iTerm2 Tango Dark` / `Light` following `prefers-color-scheme`; `src/lib/theme-manager.ts` persists the pick per mode), a Socket.IO client, and a URL ↔ command sync layer.
- **`backend/`** — Node.js + Express + Socket.IO + dockerode, split into three modules: `session.js` (`SessionManager`: per-connection timers, initCommand auto-typing gated on the prompt and first resize), `admission.js` (`Admission`: one lease per IP, capacity cap, connection rate limit, reconnect grace), `lifecycle.js` (`SessionLifecycle`: every dockerode call, the warm pool, attach/rebind). `sandbox-policy.js` is the single source of the container spec.
- **`container/`** — Ubuntu 24.04 image (`twaldin/terminal-portfolio:latest`) with zsh, Oh My Posh, neovim (nightly via bob), figlet/mdcat/glow, and `scripts/*.sh` for the portfolio (welcome, projects, blog, resume, contact, etc.).

## Frontend routing

Paths relative to `frontend/`.

- `src/app/page.tsx` mounts the terminal for `/`; `src/app/[...slug]/page.tsx` renders the same page for every command URL that passes `isValidPath` (`src/lib/routes.ts`) and 404s the rest.
- On connect, `pathToCommand` (`src/lib/websocket.ts`) turns the current path into the `initCommand` sent in the Socket.IO handshake `auth`: `/` → `boot` (intro animation, then `welcome`), `/about` → `about`, `/projects/<alias>` → `<alias>`, `/t/<cmd>` → `<cmd>` (so `/t/blog/<slug>` becomes `blog <slug>`). The backend re-validates the string (`SessionManager._autoType`) and falls back to `boot`.
- `/blog` and `/blog/<slug>` are static routes (`src/app/blog/`) that win over the catch-all: Markdown rendered for crawlers and cold loads, handing over to the live terminal through `/t/…` links and an embedded prompt that navigates to `/t/<cmd>`. `/gui` is the no-terminal page.
- The reverse direction uses OSC (operating-system-command) escape sequences: the container's zsh `preexec` hook and portfolio scripts emit OSC 9999 (`emit_url` in `container/scripts/shared-functions.sh`); `src/components/Terminal.tsx` handles 9999 (`history.pushState`), 9998 (scroll to top), 9997 (`location.assign`, same-origin only), 9996/9995 (ephemeral / persisted theme), and OSC 8 hyperlinks via `linkHandler`.
- The Socket.IO client targets `NEXT_PUBLIC_API_URL` when that was inlined at build time, otherwise the page's own origin — in production, nginx's `/socket.io/` route.

## Runtime model: pre-warmed pool + IP-pinned sessions

`SessionLifecycle` keeps **5 warm containers** ready (`poolSize`, set where `SessionManager` constructs it) so a new connection skips container creation. `Admission` enforces `maxSessions` = **40** visitor sessions — leases still acquiring a container, active leases, and zombies in their grace window; the warm spares are extra. The 41st concurrent visitor is denied (`Server is at capacity`). Every lease is an opaque `leaseId` → container `handleId` pair; `server.js` is socket wiring, the HTTP routes, and the audit log (`logger.js`).

Disconnect without `exit` (browser close, network drop) → `Admission.zombify` keeps the lease for a **30 s** grace window (`ZOMBIE_GRACE_MS`, at most one zombie per IP) so a quick reconnect can reattach without losing shell state.

Each visitor IP holds **one live session at a time** (`Admission.ipLeases`). What a second Socket.IO connection from the same IP does depends on the persistent `sessionId` the browser sends in the handshake (`localStorage` key `terminal-session-id`):

- **Same `sessionId`** (refresh, or a second tab in the same browser) → `Admission._restore` rebinds the existing container's stream to the new socket (`SessionLifecycle.rebind`), whether the old lease is still active or in its zombie window. The client gets `session_status: { mode: 'resume' }` and the URL's `initCommand` is re-run after the first resize so the output repaints. If the old tab is still open, `SessionManager._retirePreviousOwner` drops its connection: its timers are cleared, it is told `[session moved to a newer tab — refresh here to take it back]` and disconnected, so only the new tab's disconnect or idle timer can end the shell. It is not sent `session_end` (that would clear the browser-wide `sessionId`); a refresh in the old tab takes the session back the same way.
- **Different `sessionId`** (another browser on the same IP) → `Admission.tryAcquire` evicts the old lease (`Admission.destroy` → `SessionLifecycle.destroy`), which unbinds the old socket's stream listeners before ending the stream. The old tab is not told; it stops receiving output and its `SessionManager` entry lingers until its own timer fires. A `sessionId` presented from a different IP than its owner is denied (`ip-mismatch`) rather than resumed.
- Type `exit` → the container stream closes, `SessionManager._handleStreamClose` emits `session_end`, the client clears its stored `sessionId`, and the slot is freed.

Timers in `SessionManager` (`backend/session.js`), rate limit in `Admission` (`backend/admission.js`):

- **5 min idle** without keystrokes → kill (`sessionTimeout`).
- **60 s no-input** after the lease is granted → kill (`noInputTimeout`) — kills bots and background tabs that never engage. Relaxed to **5 min** (`noInputTimeoutVisible`) while the client reports its page visible via the `visibility` socket event; never-reported (no-JS bots) stays 60 s. Resize and visibility never reset the idle timer, though a visibility change re-arms the no-input countdown until the first keystroke.
- **30 connection attempts/min per IP** (`Admission.checkConnectionRate`; `MAX_CONNECTIONS_PER_IP`, `RATE_LIMIT_WINDOW_MS`), checked before any lease work.

## Sandbox / security

- Every session container is built from `SANDBOX_POLICY` by `buildContainerSpec` (`backend/sandbox-policy.js`), the only place the spec exists: non-root `portfolio` user, `CapDrop: ALL` with only `SETUID`/`SETGID` re-added for the sudo demo, `NetworkMode: 'none'`, `PidsLimit: 100`, 512 MB RAM, 0.5 CPU (`CpuQuota: 50000`), `tmpfs /tmp` (rw, noexec, nosuid, 100 MB), label `app=terminal-portfolio` so orphan reclaim never touches other tenants' containers. Visitors can run `sudo rm -rf /` or fork-bombs and affect only their own container; isolation from the host rests on the dropped capabilities plus Docker's default seccomp/AppArmor at the daemon (daemon-level hardening still open — userns-remap, storage quota — is listed in `sandbox-policy.js`).
- `tecnativa/docker-socket-proxy` exposes the Docker API to the backend over `tcp://socket-proxy:2375` with a strict allowlist (`socket-proxy` service in `docker-compose.yml`): `CONTAINERS`, `IMAGES`, `POST`, `INFO`, `PING` enabled; `NETWORKS`, `VOLUMES`, `SERVICES`, `TASKS`, `NODES`, `SWARM`, `BUILD`, `EXEC` disabled. The backend never gets a raw `/var/run/docker.sock`; `DockerodeAdapter` (`backend/lifecycle.js`) forces plain HTTP.
- `backend/proxy-validator/` is a body-validating Docker proxy that checks requests against the same `SANDBOX_POLICY`. It is built and unit-tested but deliberately **not in the data path**: its HTTP forwarder cannot relay the raw two-way socket that Docker's `attach` endpoint "hijacks" from the HTTP connection (see the comment above `socket-proxy` in `docker-compose.yml`).

## Deployment shape

`docker-compose.yml` brings up four services on three internal Docker networks plus one external bridge:

| Service        | Image / build                          | Network                     |
|----------------|----------------------------------------|-----------------------------|
| `nginx`        | `nginx:alpine` + `nginx.conf`          | external + frontend + backend |
| `frontend`     | `frontend/Dockerfile.production`        | frontend (internal)         |
| `backend`      | `backend/Dockerfile`                    | backend + docker (internal) |
| `socket-proxy` | `tecnativa/docker-socket-proxy`         | docker (internal)           |

Session containers are not declared in compose: the backend creates them through the proxy with `NetworkMode: 'none'`, so they are attached to no Docker network at all.

Nginx (`nginx.conf`) terminates TLS via Let's Encrypt (`/etc/letsencrypt` mounted read-only), enforces global rate limits (10 r/s, burst 20; `limit_conn` 10 per IP), and blocks the Next.js CVE-2025-29927 middleware-bypass header. Routes:

- `/socket.io/` → backend, WebSocket upgrade, 24 h read timeout.
- `/pv` → backend, first-party pageview beacon (`pageviews.handlePageview`).
- `/admin` → backend, Basic-auth panel over the audit log (`ADMIN_PASSWORD` from the environment).
- `/health`, `/stats` → backend, private networks only.
- `/fonts/` → frontend with immutable cache headers.
- `/agentelo*` → a separate compose stack on the shared `term-site_external-net`.
- A 444 blocklist for common exploit probes; `/resume.html` → `/resume.pdf`; every other path → frontend.

The audit log (`events.jsonl`, with daily pageview rollups appended to it) lives in the `backend_data` volume at `/app/data`.

`deploy.sh` is the production deploy entry point: builds the container image and service images first, then swaps the stack.

## Local dev

- `cd frontend && pnpm dev` (Next 15 with Turbopack, port 3000). Vitest suites in `src/lib/__tests__/`.
- `cd backend && npm start` (port 3001; needs `DOCKER_HOST` or a local docker socket). `npm test` runs every suite in `backend/test/` and `backend/proxy-validator/test/` with no daemon: `lifecycle.test.js` and the capacity cases in `admission.test.js` drive the real modules over the in-memory Docker adapter in `test/lifecycle-fake.js`; the other admission cases and the controller suites use fakes at the module seams.
- Full local stack: `docker compose -f docker-compose.yml -f docker-compose.local.yml up`. The local file is an override fragment (`nginx-local.conf` on port 8088, `linux/amd64` platforms), not a standalone compose file.
- The container image is built with `container/build.sh` → tags `twaldin/terminal-portfolio:latest`, the tag `SANDBOX_POLICY.image` requests. Nothing checks for it at startup; a missing image surfaces as a failed lease.
- Playwright e2e in `e2e/` runs against the deployed site on PRs, pushes to `main`, and nightly (`.github/workflows/e2e.yml`). A cold page load is 24–26 requests, right at the nginx per-IP limit above, and the limiter clips the trailing Terminal chunk with 503 so `.xterm` never renders (TWA-55). The suite keeps that signal: the "first visit" check runs in a plain browser context with no interception, while the "returning visitor" tests replay the immutable assets (`/_next/static/` chunks and `/fonts/`) from a per-worker cache (`e2e/immutable-assets.ts`) instead of re-downloading them in every fresh context. Every finished test run uploads the html report; a flaky pass keeps the failed attempt's trace, which is how a first-visit failure is inspected.

## Pointers

- **`frontend/CLAUDE.md`** — URL → command allowlist, Socket.IO client, Terminal component (font sizing, mobile keyboard), OSC handlers (URL ↔ command sync, theme protocol), themes, blog pages (server-rendered vs. live terminal), share cards and SEO.
- **`backend/CLAUDE.md`** — Module layout, warm pool and one lease per IP, timers and limits, container spec, boot sequence for a new visitor, initCommand validation, orphan reclaim, tests.
- **`container/CLAUDE.md`** — Layout and script inventory, image build (bob nightly nvim with baked-in plugins, Oh My Posh prompt), `.zshrc` wiring and aliases, boot intro, blog handoff, terminal control sequences (the OSC table).

## Conventions

- Every directory with a `CLAUDE.md` also has an `AGENTS.md` symlink → `CLAUDE.md`. Treat `CLAUDE.md` as canonical; edit only `CLAUDE.md`, never `AGENTS.md`.
- One-off agent docs (plans, diagnoses, handoffs, content drafts) never get committed — they live untracked in `~/notes/term-site/` on the dev machine.
