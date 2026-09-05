# frontend/

Next.js 15 (App Router, Turbopack) + React 19 client that renders the xterm.js terminal and brokers Socket.IO traffic to the backend. Tailwind 4 for the chrome around the terminal. The static HTML pages (blog, `/gui`) read the same `--color-*` variables as the terminal so cold and hot views match; the share-card images bake `DEFAULT_DARK_THEME` in directly.

## Layout

```
src/
├── app/
│   ├── layout.tsx                      # :root palette from DEFAULT_DARK_THEME, pre-paint saved-theme script, Nerd Font preloads, colorScheme "dark light", mounts PageviewBeacon + SiteHeader
│   ├── page.tsx                        # Home: <Terminal> via next/dynamic (ssr: false), WebSocketManager wiring, performance marks (window.__termTti)
│   ├── [...slug]/page.tsx              # Catch-all: isValidPath() or 404, then renders Home; URL → initCommand happens at connect time
│   ├── blog/page.tsx                   # Static post index (cold loads only)
│   ├── blog/[slug]/page.tsx            # Static post → BlogUnifiedPage; unknown slugs 301 through resolveSlugAlias()
│   ├── blog/[slug]/opengraph-image.tsx # Per-post share card (1200×630)
│   ├── gui/page.tsx                    # No-terminal overview rendered from content/gui.md
│   ├── repo-card/[name]/route.tsx      # /repo-card/<name> 1280×640 PNG from repo-card/cards.json
│   ├── opengraph-image.tsx             # Root share card (baked figlet banner)
│   ├── sitemap.ts, robots.ts
│   ├── not-found.tsx                   # "bash: command not found" 404
│   ├── globals.css                     # Tailwind + xterm.css imports, @font-face, --app-visual-viewport-height sizing
│   └── favicon.ico
├── components/
│   ├── Terminal.tsx                    # The only live xterm.js mount: OSC handlers, font sizing, mobile keyboard fit
│   ├── BlogUnifiedPage.tsx             # Static markdown + 3-row xterm mini-prompt that hands off to /t/<cmd>
│   ├── SiteHeader.tsx                  # Nav + dark/light toggle; hard reloads so each nav gets a fresh initCommand
│   └── PageviewBeacon.tsx              # sendBeacon('/pv') once per load (nginx → backend); skipped on doNotTrack
├── config/
│   ├── themes.ts                       # 463 generated Ghostty palettes + DEFAULT_DARK_THEME / DEFAULT_LIGHT_THEME
│   └── terminal-theme.ts               # terminalConfig: xterm typography + behaviour options — no colors
└── lib/
    ├── websocket.ts                    # Socket.IO client, pathToCommand() allowlist, handshake auth
    ├── routes.ts                       # isValidPath(), getPageMetadata(), getOgImage(), KNOWN_COMMANDS / PROJECT_ALIASES
    ├── theme-manager.ts                # Client theme store: mode, per-mode persisted theme, CSS vars, subscribers, flicker list
    ├── blog-posts.ts                   # Reads ./blog-posts/*.md: frontmatter, excerpts, slug aliases
    ├── safe-url.ts                     # isSafeExternalUrl(): http/https/mailto only
    ├── mobile-viewport.ts              # Pure scroll/fit math for the on-screen keyboard
    ├── xterm-touch.ts                  # attachTouchScroll(): drag + momentum scrolling for the canvas
    ├── markdown-components.tsx         # react-markdown components + CSS-var color names for static pages
    └── __tests__/                      # Vitest: websocket-allowlist, routes, safe-url, theme-manager, mobile-viewport
content/gui.md                          # Body for /gui, read from disk by app/gui/page.tsx
public/                                 # fonts/ (JetBrainsMono Nerd Font woff2 + ttf), resume.pdf, blog-snapshots/*.ansi (scripts/capture-blog-snapshots.sh; nothing in src/ reads them)
blog-posts → ../container/blog/posts    # gitignored dev symlink; Dockerfile.production COPYs the directory instead
```

## URL → command routing (allowlist)

Two frontend gates, then a backend re-check. The frontend has no denylist (the container's outbound `preexec` skip list is a separate concern — see Things to watch).

1. **Render gate** — `app/[...slug]/page.tsx` calls `isValidPath()` (`lib/routes.ts`), which strips a leading `/t/` or `/projects/`, requires the first segment to be in `KNOWN_COMMANDS`, and allows a second segment only as a `blog` slug matching `BLOG_SLUG_PATTERN` (or `projects/<known command>`). Everything else 404s; valid paths render the same `<Home>` as `/`.
2. **Command gate** — `pathToCommand()` (`lib/websocket.ts`) turns `window.location.pathname` into the `initCommand` sent in the Socket.IO handshake:
   - `/` → `boot` (intro animation, then welcome — see container/CLAUDE.md).
   - `/t/<cmd>` → drop the prefix and keep going (forces the live terminal; used by the blog pages and the header).
   - `/projects/<alias>` → `<alias>` when it is in `PROJECT_ALIASES` (legacy pretty URL).
   - Otherwise: URL-decode, cap at 200 chars, require `SAFE_CMD_RE` (`/^[A-Za-z0-9 ._/+=:,@-]+$/`), and if the string has no whitespace but contains `/`, turn the first `/` into a space (`/blog/foo` → `blog foo`). The result must then be a `NAVIGATION_COMMANDS` key or match `/^blog [A-Za-z0-9._-]+$/`. Anything else → `undefined`.
3. **Backend** — `_maybeRunInitCommand` (`backend/session.js`) types `boot` when `initCommand` is falsy, so a path that passes the render gate but not `pathToCommand()` (e.g. `/theme`) just boots. `_autoType` re-checks the character set and length as defence-in-depth and also falls back to `boot`.

## Socket.IO client (`lib/websocket.ts`)

- `createWebSocketManager()` connects to `NEXT_PUBLIC_API_URL`, else the page origin (nginx proxies `/socket.io/`), else `http://localhost:3001`. `transports: ['websocket']`, `reconnection: false`; each `connect_error` schedules another `socket.connect()` 3 s later instead.
- Handshake `auth: { initCommand, sessionId }`. `sessionId` is a lazily generated `crypto.randomUUID()` persisted in `localStorage['terminal-session-id']`; it is what lets the backend reattach the same container across a refresh.
- `boot` replays on every connect, including resume/refresh — nothing substitutes `welcome` for it. The animation and the welcome typewriter are keypress-skippable instead.
- Emits `visibility` (`{ hidden: document.hidden }`) on connect and on every `visibilitychange` so the backend relaxes its 60 s no-input bot-kill to 5 min while the tab is visible. Passive like `resize` (see Things to watch).
- The last `resize` is buffered in `lastResize` and re-emitted on `connect`, because xterm's first fit fires before the socket is ready.
- `session_status` carries `{ mode: 'cold' | 'resume' }` (the client type also declares an optional `restoredType` the backend never sends). `app/page.tsx` records `performance.mark`s (`term:*`, mirrored on `window.__termTti` for `scripts/tti-playwright.mjs`) from socket connect, first-output/prompt sniffing, and the `tti` event's `welcome-enter-sent` phase.
- `session_end` (container exited) removes the stored `sessionId` and disconnects; `app/page.tsx` then `replaceState`s the URL to `/`, clears the terminal, and reconnects after 1.5 s, so the next session starts from `/` rather than whatever path the shell last pushed (e.g. `/exit`).

## Terminal component (`components/Terminal.tsx`)

- Single xterm.js instance, mounted client-side only (`dynamic(() => import('@/components/Terminal'), { ssr: false })` in `app/page.tsx`). Output that arrives before mount is buffered in `outputBufferRef` and flushed on open.
- Addons: `FitAddon`; `WebglAddon` inside a try/catch and disposed on context loss (either way xterm falls back to its default DOM renderer — there is no canvas addon in `package.json`); `WebLinksAddon` loaded on the host's first `mouseover` to keep TTI cheap.
- Font: JetBrainsMono Nerd Font Mono. `@font-face` in `app/globals.css` (woff2 with ttf fallback), preloaded from `app/layout.tsx` with `crossOrigin="anonymous"`. xterm opens before the font is guaranteed loaded; `document.fonts.ready` triggers a re-fit once the swap changes glyph widths.
- `calculateFontSize()`: viewport-width-driven, clamped `MIN_FONT_SIZE`–`MAX_FONT_SIZE` (10–28 px). Below `MOBILE_BREAKPOINT` (768 px) it derives a 40–80 col target from `usableWidth / (MIN_FONT_SIZE * CHAR_WIDTH_RATIO)`; desktop is `round(viewportWidth / 80)`. Cols/rows fall out of `FitAddon` rather than being set explicitly so figlet boxes scale naturally. `terminalConfig` (`config/terminal-theme.ts`) supplies xterm typography and behaviour (font, line height, cursor, scrollback, `macOptionIsMeta`, proposed-API flag, default cols/rows) — palettes come from theme-manager.
- Mobile keyboard: `visualViewport` resize/scroll listeners write `--app-visual-viewport-height` (consumed by `body:has(.terminal-host)` in `globals.css`) and re-fit on the `KEYBOARD_UPDATE_DELAYS_MS` ladder; the pure math (`getPromptVisibleScrollTarget`, `getScrollDeltaToKeepElementVisible`, `shouldEmitTerminalResize`) lives in `lib/mobile-viewport.ts`. Touch drag/momentum scrolling is `attachTouchScroll()` in `lib/xterm-touch.ts`.

## OSC handlers — URL ↔ command sync

The container's portfolio scripts and zsh `preexec` hook emit OSC sequences (`emit_url`, `emit_navigate` in `container/scripts/shared-functions.sh`) that `Terminal.tsx` registers with `xterm.parser.registerOscHandler`:

- **OSC 9999 `<path>`** — `history.pushState` to `/<path>` (leading slashes collapse to one, so `//evil.com` becomes `/evil.com`); no-op when the pathname already matches.
- **OSC 9998** — `xterm.scrollToTop()`.
- **OSC 9997 `<path>`** — hard-navigate with `location.assign`, used when the shell wants the browser to leave the terminal page (e.g. `blog <slug>` → the static post). Collapses leading slashes so `//evil.com` becomes the same-origin `/evil.com`, rejects backslashes and `scheme:` prefixes, then resolves against `window.location.origin` and refuses anything cross-origin.
- **OSC 9996 `<name>`** — ephemeral palette switch for animations. Empty payload → `applySaved()`; `next` → `applyNextFlickerTheme()` through `FLICKER_PAIRS` (paired near-black/near-white themes so the flicker follows the visitor's mode).
- **OSC 9995 `<name>`** — persist the visitor's theme for the current mode (`setAndPersistTheme`); `dark`/`light` → `setMode`; `reset` → `resetThemeChoices`.
- **OSC 8** hyperlinks (mdcat output): `xterm.options.linkHandler.activate` and the `WebLinksAddon` share `handleLinkActivate`, which opens a new tab (`noopener,noreferrer`) only if `isSafeExternalUrl()` (`lib/safe-url.ts`) accepts the scheme — `http:`, `https:`, `mailto:`. `allowNonHttpProtocols: true` is what lets `mailto:` reach that check.

The two theme handlers apply via `setTimeout(…, 0)`: mutating `xterm.options.theme` synchronously inside the parser callback can freeze the renderer when previews arrive in bursts (theme picker).

## Themes

- `config/themes.ts` — 463 Ghostty palettes keyed by name, generated by the repo-root `scripts/generate-themes-lib.py` from a local Ghostty install; do not edit by hand. Defaults: `DEFAULT_DARK_THEME = "iTerm2 Tango Dark"`, `DEFAULT_LIGHT_THEME = "iTerm2 Tango Light"`; change them with `./scripts/generate-themes-lib.py --dark "<name>" --light "<name>"`. `container/scripts/themes.txt` must list the same names for the in-shell `theme` picker.
- `lib/theme-manager.ts` — client store: mode `dark | light | auto` (`term-site:mode`), one persisted theme per mode (`term-site:theme-dark` / `term-site:theme-light`). `applyThemeEntry` writes the `--color-*` vars on `:root` and notifies `subscribe()` callers (Terminal, BlogUnifiedPage, SiteHeader).
- Anti-FOUC: every persisted change also snapshots the full palette to `term-site:palette`; the inline script in `app/layout.tsx` applies it before first paint, so saved themes survive navigations without flashing the default. Keep that script's variable list in sync with `applyThemeEntry`.

## Blog: static cold + live hot

- Posts are markdown in `container/blog/posts`; the frontend reads them from `./blog-posts` (`POSTS_DIR` in `lib/blog-posts.ts`) — a gitignored symlink in dev, a `COPY` in `Dockerfile.production`. `listPostSlugs()` returns `[]` when the directory is missing, so a fresh checkout builds with an empty blog.
- `app/blog/page.tsx` is the static index; `app/blog/[slug]/page.tsx` renders `BlogUnifiedPage` (statically generated per slug) and sends an unknown slug through `resolveSlugAlias()` to a `permanentRedirect()` (HTTP 308) when it matches exactly one post. Typing `blog` in the live terminal pushes `/blog` via OSC 9999 without a reload, so these pages only render on cold loads.
- The handoff to the live terminal is the embedded prompt, not a link: `BlogUnifiedPage` mounts a 3-row xterm below the article, buffers keystrokes, and on Enter does `location.assign('/t/' + encodeURIComponent(cmd))`. That path then goes through both routing gates like any other: allowlisted commands run, commands unknown to `isValidPath()` 404, and the few that pass the render gate but not `pathToCommand()` boot. Footer links go to `/`, `/t/blog`, `/t/projects`, `/t/resume`.
- The empty-string `initCommand` sentinel in `_maybeRunInitCommand` (`backend/session.js`) is backend-only; `pathToCommand()` never returns `''`.

## Static pages, share cards, SEO

- `/gui` (`app/gui/page.tsx`) renders `content/gui.md` through `react-markdown`, reading it with `readFileSync` from `process.cwd()`; `Dockerfile.production` copies `content/` alongside `blog-posts/` so the file is present wherever Next renders the page.
- Share cards are `next/og` `ImageResponse`s that read `public/fonts/JetBrainsMonoNerdFontMono-Regular.ttf` from disk: `app/opengraph-image.tsx` (root, baked figlet), `app/blog/[slug]/opengraph-image.tsx` (per post), `app/repo-card/[name]/route.tsx` (1280×640 per repo from `cards.json`, `force-static`; add repos with `scripts/add-repo-card.sh`). `getOgImage()` in `lib/routes.ts` picks the repo card for project aliases (except `also`, which has no card; `term-site` maps to the `tim.waldin.net` card) and the root card otherwise.
- `app/sitemap.ts` lists `/`, `/gui`, `/blog`, every post, and `/projects/<alias>`; `app/robots.ts` allows everything and points at it. `getPageMetadata()` supplies titles/descriptions for `layout.tsx` and the catch-all.
- `next.config.ts`: `output: "standalone"` (what the Dockerfile ships) and a permanent `/resume.html` → `/resume.pdf` redirect (nginx has the same rule).

## SiteHeader

`NAV_ITEMS` link to `/`, `/t/blog`, `/t/projects`, `/t/resume`, `/t/about`, `/t/contact`; `hardNav()` forces a full reload so every navigation opens a new socket with that path's `initCommand` (the stored `sessionId` reattaches the same container). Colors come from the `--color-*` vars so the header re-themes live; the right-hand button shows the resolved mode and calls `setMode()` to flip it. Below Tailwind's `sm` breakpoint (640 px) the nav collapses into a `<details>` dropdown (closes on outside click / Escape) — the header must stay one row on phones.

## Dev / build / tests

- `pnpm dev` → Next 15 with Turbopack on port 3000 (`next dev --turbopack --port 3000`); `pnpm build` / `pnpm start` for production; `pnpm lint` → `next lint`.
- `pnpm test` → `vitest run` (`vitest.config.ts`: node environment, `@` → `src`). Suites in `src/lib/__tests__/`: `websocket-allowlist` (asserts `pathToCommand()` through the handshake `auth`), `routes`, `safe-url`, `theme-manager`, `mobile-viewport`.
- Local blog content: `ln -s ../container/blog/posts frontend/blog-posts` (gitignored).
- Production image: `frontend/Dockerfile.production`, built from the repo root (it copies `container/blog/posts/`). Standalone server (`node server.js`) as the non-root `nextjs` user; `.next/static`, `public/`, `blog-posts/`, and `content/` are copied in explicitly because standalone tracing omits them. The compose service runs `read_only: true` with a 50 MB `tmpfs` at `/tmp` (`docker-compose.yml`).

## Things to watch

- xterm references `self` at module load — keep `Terminal.tsx` behind `next/dynamic` with `ssr: false`. Removing that breaks `next build`.
- Adding a command touches two allowlists: `NAVIGATION_COMMANDS` / `PROJECT_ALIASES` in `lib/websocket.ts` (what may auto-type) and `KNOWN_COMMANDS` / `PROJECT_ALIASES` in `lib/routes.ts` (what renders instead of 404). They already differ: `/boot` and `/theme` render but fall through to `boot`.
- The container's `preexec` pushes a URL for every typed command (its own skip list lives in `container/Dockerfile`), so a visitor can refresh on a path the frontend will not accept — `/ls` 404s. The two directions are not symmetric.
- Resize is a *passive* signal in the backend (it doesn't reset idle timers); don't try to use it as a heartbeat.
- The persistent `sessionId` is per-browser, not per-tab — a second tab from the same browser presents the same id, so `Admission.tryAcquire` (`backend/admission.js`) restores that lease and rebinds its output to the new socket instead of leasing a fresh container, and `SessionManager` disconnects the first tab with a `[session moved to a newer tab — refresh here to take it back]` line (no `session_end`, so `terminal-session-id` survives for the new tab).
