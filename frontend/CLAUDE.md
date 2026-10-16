# frontend/

Next.js 15 (App Router, Turbopack) + React 19 client that renders the xterm.js terminal and brokers Socket.IO traffic to the backend. Tailwind 4 for the chrome around the terminal. The static HTML pages (blog, `/gui`) read the same `--color-*` variables as the terminal so cold and hot views match; the share-card images bake `DEFAULT_DARK_THEME` in directly.

## Layout

```
src/
├── app/
│   ├── layout.tsx                      # :root palettes from DEFAULT_DARK_THEME / DEFAULT_LIGHT_THEME (prefers-color-scheme), theme-color per scheme, pre-paint saved-theme script, Nerd Font preloads, colorScheme "dark light", mounts PageviewBeacon + SiteHeader
│   ├── page.tsx                        # Home: <Terminal> via next/dynamic (ssr: false), WebSocketManager wiring, performance marks (window.__termTti), one-line message on session_denied
│   ├── [...slug]/page.tsx              # Catch-all: isValidPath() or 404, then renders Home; URL → initCommand happens at connect time
│   ├── blog/page.tsx                   # Static post index (cold loads only)
│   ├── blog/[slug]/page.tsx            # Static post → BlogUnifiedPage; unknown slugs 301 through resolveSlugAlias()
│   ├── blog/[slug]/opengraph-image.tsx # Per-post share card (1200×630)
│   ├── gui/page.tsx                    # No-terminal overview rendered from content/gui.md
│   ├── x/page.tsx                      # /x X Player Card: player metadata, renders XEmbed (see "/x embed")
│   ├── x/XEmbed.tsx                    # Embed UI: embedded <Terminal>, extra-keys row on coarse pointers, status line
│   ├── x/twitter-image.tsx             # Square 1200×1200 player-card image (also /x's og:image)
│   ├── repo-card/[name]/route.tsx      # /repo-card/<name> 1280×640 PNG from repo-card/cards.json
│   ├── opengraph-image.tsx             # Root share card (baked figlet banner)
│   ├── sitemap.ts, robots.ts
│   ├── not-found.tsx                   # "bash: command not found" 404
│   ├── globals.css                     # Tailwind + xterm.css imports, @font-face, --app-visual-viewport-height sizing
│   └── favicon.ico
├── components/
│   ├── Terminal.tsx                    # The only live xterm.js mount: OSC handlers, font sizing, mobile keyboard fit, `embedded` mode, setGrid()/pressKey()
│   ├── BlogUnifiedPage.tsx             # Static markdown + 3-row xterm mini-prompt that hands off to /t/<cmd>
│   ├── SiteHeader.tsx                  # Nav + dark/light toggle; hard reloads so each nav gets a fresh initCommand; renders nothing on /x
│   └── PageviewBeacon.tsx              # sendBeacon('/pv') once per load (nginx → backend); skipped on doNotTrack
├── config/
│   ├── themes.ts                       # 464 generated palettes + DEFAULT_DARK_THEME / DEFAULT_LIGHT_THEME
│   └── terminal-theme.ts               # terminalConfig: xterm typography + behaviour options — no colors
└── lib/
    ├── websocket.ts                    # Socket.IO client, pathToCommand() allowlist, handshake auth per session kind, session_denied
    ├── embed-machine.ts                # /x state machine: pure transition() over tour / connecting / live / busy / ended
    ├── embed-client.ts                 # /x driver: gesture + visibility listeners, socket, tour player, retry timer, effects per phase
    ├── embed-tour.ts                   # parseTour() for public/x/tour.json, playTour() loop
    ├── terminal-sizing.ts              # Pure font-size rules: site viewport, live embed, fixed tour grid
    ├── routes.ts                       # isValidPath(), getPageMetadata(), getOgImage(), KNOWN_COMMANDS / PROJECT_ALIASES
    ├── theme-manager.ts                # Client theme store: mode, per-mode persisted theme, CSS vars, subscribers, flicker list
    ├── blog-posts.ts                   # Reads ./blog-posts/*.md: frontmatter, excerpts, slug aliases
    ├── safe-url.ts                     # isSafeExternalUrl(): http/https/mailto only
    ├── mobile-viewport.ts              # Pure scroll/fit math for the on-screen keyboard
    ├── xterm-touch.ts                  # attachTouchScroll(): drag + momentum scrolling for the canvas
    ├── markdown-components.tsx         # react-markdown components + CSS-var color names for static pages; `[![alt](poster)](clip.mp4)` renders an inline muted autoplay <video>
    └── __tests__/                      # Vitest: websocket-allowlist, websocket-session, embed-machine, embed-tour, terminal-sizing, routes, safe-url, theme-manager, mobile-viewport
content/gui.md                          # Body for /gui, read from disk by app/gui/page.tsx
public/                                 # fonts/ (JetBrainsMono Nerd Font Mono woff2 + ttf, licenses), resume.pdf, x/tour.json (recorded by scripts/record-tour.mjs)
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

- `createWebSocketManager({ kind?, isHidden? })` connects to `NEXT_PUBLIC_API_URL`, else the page origin (nginx proxies `/socket.io/`), else `http://localhost:3001`. `transports: ['websocket']`, `reconnection: false`; each `connect_error` schedules another `socket.connect()` 3 s later instead (cancelled by `disconnect()`).
- `SESSION_KINDS` holds everything that differs per session kind:
  - `site` (default): handshake `auth: { initCommand, sessionId }`. `sessionId` is a lazily generated `crypto.randomUUID()` persisted in `localStorage['terminal-session-id']`; it is what lets the backend reattach the same container across a refresh. Every storage access is in a try/catch with an in-memory fallback, so blocked or throwing storage (partitioned third-party frames, privacy modes) keeps one id for the page instead of throwing.
  - `embed` (`/x`): handshake `auth: { kind: 'embed', sessionId }` with no `initCommand` key, so the backend skips the boot animation. The id lives in memory only, one per manager: two embeds in one browser hold separate leases, and a reconnect from the same embed within the zombie grace resumes its shell.
- `session_denied { reason: 'capacity' | 'ip-cap' | 'unavailable' }` reaches `onDenied`; any other payload parses to `unavailable`. The server disconnects right after. `app/page.tsx` prints one line per reason instead of leaving a blank terminal.
- `boot` replays on every connect, including resume/refresh — nothing substitutes `welcome` for it. The animation and the welcome typewriter are keypress-skippable instead.
- Emits `visibility` (`{ hidden: isHidden() }`, default `document.hidden`) on connect, on every `visibilitychange`, and on `reportVisibility()`, so the backend relaxes its no-input bot-kill while the reader can see the terminal. Passive like `resize` (see Things to watch).
- `sendInput` drops strings over 1024 characters (the backend's input cap), so a longer paste does nothing rather than exceeding the backend's 8 KiB `maxHttpBufferSize`, which would close the transport.
- The last `resize` is buffered in `lastResize` and re-emitted on `connect`, because xterm's first fit fires before the socket is ready.
- `session_status` carries `{ mode: 'cold' | 'resume' }` (the client type also declares an optional `restoredType` the backend never sends). `app/page.tsx` records `performance.mark`s (`term:*`, mirrored on `window.__termTti` for browser-console inspection) from socket connect, first-output/prompt sniffing, and the `tti` event's `welcome-enter-sent` phase.
- `session_end` (container exited) forgets the `sessionId` and disconnects; `app/page.tsx` then `replaceState`s the URL to `/`, clears the terminal, and reconnects after 1.5 s, so the next session starts from `/` rather than whatever path the shell last pushed (e.g. `/exit`).

## Terminal component (`components/Terminal.tsx`)

- Single xterm.js instance, mounted client-side only (`dynamic(() => import('@/components/Terminal'), { ssr: false })` in `app/page.tsx`). Output that arrives before mount is buffered in `outputBufferRef` and flushed on open.
- Addons: `FitAddon`; `WebglAddon` inside a try/catch and disposed on context loss (either way xterm falls back to its default DOM renderer — there is no canvas addon in `package.json`); `WebLinksAddon` loaded on the host's first `mouseover` to keep TTI cheap.
- Font: JetBrainsMono Nerd Font Mono. `@font-face` in `app/globals.css` (woff2 with ttf fallback), preloaded from `app/layout.tsx` with `crossOrigin="anonymous"`. xterm opens before the font is guaranteed loaded; `document.fonts.ready` triggers a re-fit once the swap changes glyph widths.
- Font size comes from `lib/terminal-sizing.ts`. Site: `viewportFontSize()`, viewport-width-driven, clamped 10–28 px; below 768 px it derives a 40–80 col target from the usable width at the minimum font, desktop is `round(viewportWidth / 80)`. Cols/rows fall out of `FitAddon` rather than being set explicitly so figlet boxes scale naturally. `terminalConfig` (`config/terminal-theme.ts`) supplies xterm typography and behaviour (font, line height, cursor, scrollback, `macOptionIsMeta`, proposed-API flag, default cols/rows) — palettes come from theme-manager.
- `embedded` (only `/x`): OSC 9999 and 9997 are not registered, so the frame never rewrites its URL or navigates; xterm is not focused on mount (focusing a third-party frame can scroll the host page to it); the live font comes from `embedLiveFontSize()`. `setGrid({ cols, rows })` pins a fixed grid with the font from `gridFontSize()`, `setGrid(null)` returns to fitting the host; either way the next frame always reports the size through `onResize`. `pressKey()` types esc/tab/enter/arrows through `xterm.input()`, so they reach `onData` like typed keys (arrows switch to SS3 in application cursor mode).
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

- `config/themes.ts` — 464 palettes keyed by name, generated by the repo-root `scripts/generate-themes-lib.py` from a local Ghostty install plus the Ghostty-format files in `scripts/themes/` (site-made themes; `Hardcore Light` mirrors `Hardcore` for light backgrounds); do not edit by hand. Defaults: `DEFAULT_DARK_THEME = "Hardcore"`, `DEFAULT_LIGHT_THEME = "Hardcore Light"`; change them with `./scripts/generate-themes-lib.py --dark "<name>" --light "<name>"`. The same run writes `container/scripts/themes.txt`, the name list the in-shell `theme` picker reads.
- `lib/theme-manager.ts` — client store: mode `dark | light | auto` (`term-site:mode`), one persisted theme per mode (`term-site:theme-dark` / `term-site:theme-light`). `applyThemeEntry` writes the `--color-*` vars on `:root` and notifies `subscribe()` callers (Terminal, BlogUnifiedPage, SiteHeader).
- Anti-FOUC: `app/layout.tsx` renders both default palettes as CSS (`:root` dark, `@media (prefers-color-scheme: light)` light), so a first visit paints the default `auto` mode would resolve. Every persisted change also snapshots the full palette to `term-site:palette`. The inline `PRE_PAINT_SCRIPT` in `app/layout.tsx` resolves the mode as theme-manager does (`term-site:mode`, else `prefers-color-scheme`) and, before first paint, applies the snapshot only when it has that mode and the visitor chose a theme for it (`term-site:theme-dark` / `-light`); otherwise it applies that mode's default. So saved themes survive navigations, and a snapshot from an older site default or the other mode never flashes. `initialize()` rewrites an existing snapshot to the resolved theme to keep it current. `PALETTE_VARS` feeds both the CSS defaults and the script; keep it in sync with `applyThemeEntry`.

## Blog: static cold + live hot

- Posts are markdown in `container/blog/posts`; the frontend reads them from `./blog-posts` (`POSTS_DIR` in `lib/blog-posts.ts`) — a gitignored symlink in dev, a `COPY` in `Dockerfile.production`. `listPostSlugs()` returns `[]` when the directory is missing, so a fresh checkout builds with an empty blog.
- `app/blog/page.tsx` is the static index; `app/blog/[slug]/page.tsx` renders `BlogUnifiedPage` (statically generated per slug) and sends an unknown slug through `resolveSlugAlias()` to a `permanentRedirect()` (HTTP 308) when it matches exactly one post. Typing `blog` in the live terminal pushes `/blog` via OSC 9999 without a reload, so these pages only render on cold loads.
- The handoff to the live terminal is the embedded prompt, not a link: `BlogUnifiedPage` mounts a 3-row xterm below the article, buffers keystrokes, and on Enter does `location.assign('/t/' + encodeURIComponent(cmd))`. That path then goes through both routing gates like any other: allowlisted commands run, commands unknown to `isValidPath()` 404, and the few that pass the render gate but not `pathToCommand()` boot. Footer links go to `/`, `/t/blog`, `/t/projects`, `/t/resume`.
- The empty-string `initCommand` sentinel in `_maybeRunInitCommand` (`backend/session.js`) is backend-only; `pathToCommand()` never returns `''`.

## `/x` embed (X Player Card)

A post linking `https://tim.waldin.net/x` plays the terminal inside the post: X frames `/x` on desktop web and opens it in its in-app browser on phones. A viral post must not cost a container per view.

- **Metadata** (`app/x/page.tsx`): one `twitter:card` = `player` (the page's `twitter.card` replaces the root layout's `summary_large_image`), `players: []`, and `twitter:player` / `twitter:player:width` / `twitter:player:height` (480) through `metadata.other`, because Next 15's player descriptor requires a `streamUrl` the terminal does not have. `app/x/twitter-image.tsx` is the square card image; `openGraph.images` points at it too. `SiteHeader` renders nothing on `/x`.
- **Click to start**: no socket until a `pointerdown` on the embed root or a `keydown` in the frame. The only backend request before that is `PageviewBeacon`'s `/pv` with path `/x`, which costs no container; `/x` views against `kind: 'embed'` `session_start` events give the play rate. A gesture focuses xterm, so a session started from the keyboard keeps its first keystroke, and `XEmbed` remembers a gesture made before the xterm chunk loads. Before that, `public/x/tour.json` loops at its recorded grid with the font scaled to fit (`setGrid`). `parseTour()` validates it at the fetch; a missing or invalid tour leaves a static "click for a live shell" screen, never a socket. The tour comes from `scripts/record-tour.mjs` (`node scripts/record-tour.mjs --url <backend>` after `pnpm install` in `frontend/`); re-record it rather than editing it.
- **Phases**: `lib/embed-machine.ts` decides every transition (pure, unit-tested); `lib/embed-client.ts` runs the effects when a phase is entered:
  - `tour` → the tour plays.
  - `connecting` (gesture) → `connect()` as `kind: 'embed'`; the tour keeps playing and keystrokes are buffered.
  - `live` (first `session_status` or `output`, whichever arrives first: a cold lease replays its warmed prompt as `output` before `session_status`) → reset, refit to the frame, hint line `live shell: try projects, about, blog`, resize reported, buffered keystrokes flushed once.
  - `busy` (`session_denied` `capacity` / `ip-cap`) → tour plus status line; a 30 s `retryTimer` retries only while visible and below 10 automatic retries (`autoRetries`); any gesture retries and resets the count.
  - `ended` (`disconnect`, `connect_error`, `session_end`, or `session_denied` `unavailable`) → tour plus "press any key for a new shell".
- **Visibility** sent to the backend is `document.visibilityState === 'hidden'` or the embed root not intersecting the viewport (IntersectionObserver), so a post scrolled off-screen in X's timeline counts as hidden and gets the short hidden no-input window.
- **Sizing**: live mode needs `embedMinCols()` columns, 64 from 440 px wide and 50 below (the welcome box needs 40). `embedLiveFontSize()` guesses the font from xterm's cell math (device-pixel snapping, the 15 px scrollbar allowance), then `Terminal`'s `fitLayout()` steps the font down after each fit until the fitted grid really has that many columns, because glyph advances snap differently per platform (Linux hinting turns 6.6 px into 7). The tour's `gridFontSize()` may go down to 6 px so a 320 px phone shows every recorded column.
- **Touch**: on `(pointer: coarse)` an extra-keys row (esc, tab, sticky ctrl, arrows, enter) sits under the terminal. The buttons cancel `mousedown` and have `tabIndex={-1}` so xterm keeps focus and the on-screen keyboard stays open; sticky ctrl maps the next typed character to its control code.
- **Headers**: `next.config.ts` builds both CSPs from one function; the exact `/x` rule after the global one changes only `frame-ancestors` to `'self' https://x.com https://*.x.com https://twitter.com https://*.twitter.com` (the last matching header wins). nginx's `location = /x` hides `X-Frame-Options: SAMEORIGIN` for this one path.

## Static pages, share cards, SEO

- `/gui` (`app/gui/page.tsx`) renders `content/gui.md` through `react-markdown`, reading it with `readFileSync` from `process.cwd()`; `Dockerfile.production` copies `content/` alongside `blog-posts/` so the file is present wherever Next renders the page.
- Share cards are `next/og` `ImageResponse`s that read `public/fonts/JetBrainsMonoNerdFontMono-Regular.ttf` from disk: `app/opengraph-image.tsx` (root, baked figlet), `app/blog/[slug]/opengraph-image.tsx` (per post), `app/x/twitter-image.tsx` (square 1200×1200 player card), `app/repo-card/[name]/route.tsx` (1280×640 per repo from `cards.json`, `force-static`; add repos with `scripts/add-repo-card.sh`). The dynamic share-card routes enumerate their valid parameters and reject unknown blog slugs or repository names with a 404 before reading fonts or constructing an `ImageResponse`. `getOgImage()` in `lib/routes.ts` picks the repo card for project aliases (except `also`, which has no card; `term-site` maps to the `tim.waldin.net` card) and the root card otherwise.
- `app/sitemap.ts` lists `/`, `/gui`, `/blog`, every post, and `/projects/<alias>`; `app/robots.ts` allows everything and points at it. `getPageMetadata()` supplies titles/descriptions for `layout.tsx` and the catch-all.
- `next.config.ts`: `output: "standalone"` (what the Dockerfile ships), no `X-Powered-By`, a permanent `/resume.html` → `/resume.pdf` redirect (nginx has the same rule), and production-only response headers. The static CSP permits only same-origin scripts, styles, fonts, connections, frames, and forms (plus `data:`/`blob:` images, and `wss://tim.waldin.net` spelled out because Safari < 16 does not match same-origin `wss:` against `'self'`); inline scripts/styles remain enabled for Next bootstrap, the anti-FOUC script, and React style attributes. The Permissions Policy disables unused sensor, media-capture, geolocation, payment, and USB features, allows autoplay and fullscreen for the site's own origin only (blog videos play inline and can go fullscreen), and leaves clipboard access available for the terminal.
- The `/x` route overrides only the CSP's `frame-ancestors`; see `/x` embed.

## SiteHeader

`NAV_ITEMS` link to `/`, `/t/blog`, `/t/projects`, `/t/resume`, `/t/about`, `/t/contact`; `hardNav()` forces a full reload so every navigation opens a new socket with that path's `initCommand` (the stored `sessionId` reattaches the same container). Colors come from the `--color-*` vars so the header re-themes live; the right-hand button shows the resolved mode and calls `setMode()` to flip it. Below Tailwind's `sm` breakpoint (640 px) the nav collapses into a `<details>` dropdown (closes on outside click / Escape) — the header must stay one row on phones. It renders nothing on `/x`, which is only the terminal.

## Dev / build / tests

- `pnpm dev` → Next 15 with Turbopack on port 3000 (`next dev --turbopack --port 3000`); `pnpm build` / `pnpm start` for production; `pnpm lint` → `next lint`.
- `pnpm test` → `vitest run` (`vitest.config.ts`: node environment, `@` → `src`). Suites in `src/lib/__tests__/`: `websocket-allowlist` (asserts `pathToCommand()` through the handshake `auth`), `websocket-session` (session ids with throwing storage, embed handshake), `embed-machine`, `embed-tour`, `terminal-sizing`, `routes`, `safe-url`, `theme-manager`, `mobile-viewport`.
- Local blog content: `ln -s ../container/blog/posts frontend/blog-posts` (gitignored).
- Production image: `frontend/Dockerfile.production`, built from the repo root (it copies `container/blog/posts/`). Standalone server (`node server.js`) as the non-root `nextjs` user; `.next/static`, `public/`, `blog-posts/`, and `content/` are copied in explicitly because standalone tracing omits them. The compose service runs `read_only: true` with a 50 MB `tmpfs` at `/tmp` (`docker-compose.yml`).

## Things to watch

- xterm references `self` at module load — keep `Terminal.tsx` behind `next/dynamic` with `ssr: false`. Removing that breaks `next build`.
- Adding a command touches two allowlists: `NAVIGATION_COMMANDS` / `PROJECT_ALIASES` in `lib/websocket.ts` (what may auto-type) and `KNOWN_COMMANDS` / `PROJECT_ALIASES` in `lib/routes.ts` (what renders instead of 404). They already differ: `/boot` and `/theme` render but fall through to `boot`.
- The container's `preexec` pushes a URL for every typed command (its own skip list lives in `container/Dockerfile`), so a visitor can refresh on a path the frontend will not accept — `/ls` 404s. The two directions are not symmetric.
- Resize is a *passive* signal in the backend (it doesn't reset idle timers); don't try to use it as a heartbeat.
- The persistent `sessionId` is per-browser, not per-tab — a second tab from the same browser presents the same id, so `Admission.tryAcquire` (`backend/admission.js`) restores that lease and rebinds its output to the new socket instead of leasing a fresh container, and `SessionManager` disconnects the first tab with a `[session moved to a newer tab — refresh here to take it back]` line (no `session_end`, so `terminal-session-id` survives for the new tab).
