# frontend/

Next.js 15 (App Router, Turbopack) + React 19 client that renders the xterm.js terminal and brokers Socket.IO traffic to the backend. Tailwind 4 for the chrome around the terminal; the terminal itself is themed via the xterm.js options object (`src/config/terminal-theme.ts`) using Gruvbox Dark.

## Layout

```
src/
├── app/
│   ├── layout.tsx          # Nerd Font preload + dark colorScheme + SiteHeader
│   ├── page.tsx            # Home: mounts <Terminal>, wires WebSocket manager, TTI marks
│   ├── globals.css
│   ├── not-found.tsx
│   ├── blog/[slug]/        # Static blog page (cold) — links to /t/<cmd> for live term
│   └── [...slug]/          # Catch-all that maps URL → initCommand at connect time
├── components/
│   ├── Terminal.tsx        # The only xterm.js mount in the app
│   ├── BlogRouter.tsx
│   ├── BlogUnifiedPage.tsx
│   └── SiteHeader.tsx
├── config/terminal-theme.ts
└── lib/
    ├── websocket.ts        # Socket.IO client + URL→command sync + safety lists
    ├── xterm-touch.ts      # Mobile pan/scroll handling
    ├── markdown-components.tsx
    └── routes.ts           # Per-path metadata + canonical URL helpers
```

## Terminal component (`components/Terminal.tsx`)

- Single xterm.js instance, mounted client-side only (`dynamic(import, { ssr: false })` in `app/page.tsx:9`).
- Addons loaded: `FitAddon`, `WebglAddon` (with canvas fallback on context loss), `WebLinksAddon` (deferred until first hover to keep TTI cheap).
- Font: JetBrainsMono Nerd Font, preloaded as woff2 in `app/layout.tsx:47-60`. xterm boots with a system fallback first; `document.fonts.ready` triggers a re-fit when the Nerd Font swap-in changes glyph widths (`Terminal.tsx:160-165`).
- Dynamic font sizing in `calculateFontSize()` (`Terminal.tsx:25-35`): viewport-width-driven, clamped 10–28 px, mobile branch derives target cols from `usableWidth / (MIN_FONT_SIZE * 0.6)`. Cols/rows fall out of `FitAddon` rather than being set explicitly so figlet boxes scale naturally.
- Touch scroll handling lives in `lib/xterm-touch.ts` (mobile pan, momentum, dead-zone above the keyboard).

## OSC handlers — URL ↔ command sync

The container's zsh `preexec` hook emits OSC sequences that the frontend parses to keep the URL in sync with what's running in the shell:

- **OSC 9999** (`Terminal.tsx:99`): `\x1b]9999;<path>\x07` → `history.pushState` to `/<path>`. Used by `welcome`, project pages, blog, etc. Same-origin only.
- **OSC 9998** (`Terminal.tsx:109`): scroll terminal to top.
- **OSC 9997** (`Terminal.tsx:114`): hard-navigate via `location.assign` — used when the shell wants the browser to leave the terminal page entirely (e.g. blog cold page). Strips leading slashes and rejects scheme-prefixed input.
- **OSC 8** hyperlinks: standard terminal hyperlinks. Activation is overridden via `xterm.options.linkHandler` to open in a new tab (`Terminal.tsx:81-87`).

## Socket.IO client (`lib/websocket.ts`)

- Persistent `sessionId` stored in `localStorage` under `terminal-session-id` (UUID v4, generated lazily). Sent in the Socket.IO handshake `auth` so backend reattach works across refresh.
- `pathToCommand(pathname)` (`websocket.ts:26`): maps the current URL to the `initCommand` that gets sent in the handshake. Rules:
  - `/` → `welcome`
  - `/t/<cmd>` → `<cmd>` (forces live terminal, used by blog cold pages)
  - `/projects/<alias>` → `<alias>` (legacy pretty URL, only for known aliases)
  - Anything else → URL-decoded path, validated against `SAFE_CMD_RE` and `BLOCKED_HEADS`. Spaces decode from `%20`; a leading `/` separator (e.g. `/blog/foo`) is converted to a space (`blog foo`).
- Two safety lists also enforced backend-side as defence-in-depth:
  - `SAFE_CMD_RE` = `/^[A-Za-z0-9 ._/+=:,@-]+$/` — blocks shell metachars.
  - `BLOCKED_HEADS` = `rm`, `mv`, `cp`, `dd`, `sudo`, `su`, `chmod`, `chown`, `kill`, `pkill`, `killall`, `sh`, `bash`, `zsh`, `dash`, `eval`, `exec`, `source`, `mkfs`, `mount`, `umount`, `exit`, `logout`.

## Blog: static cold + live hot

The blog has two modes: `app/blog/[slug]/page.tsx` is a static (SSR) markdown render for fast first paint and SEO; once the user interacts, the page hands over to the live terminal via a `/t/blog%20<slug>` link. The handoff sends an empty-string `initCommand` to the backend (sentinel: don't auto-type, don't overwrite the user's input) — see `backend/session.js:664`.

## Dev / build

- `pnpm dev` → Next 15 with Turbopack on port 3000 (`package.json` script: `next dev --turbopack --port 3000`).
- `pnpm build` / `pnpm start` for production.
- Vitest unit tests in `src/lib/__tests__/`.
- Production image: `frontend/Dockerfile.production`. Runs read-only with a 50MB tmpfs at `/tmp` (see `docker-compose.yml:33-37`).

## Things to watch

- xterm references `self` at module load — keep `Terminal.tsx` behind `next/dynamic` with `ssr: false`. Removing that breaks `next build`.
- Resize is a *passive* signal in the backend (it doesn't reset idle timers); don't try to use it as a heartbeat.
- The persistent `sessionId` is per-browser, not per-tab — opening a new tab from the same browser hits the IP-pinned-session collapse logic in the backend, not a fresh-session path.
