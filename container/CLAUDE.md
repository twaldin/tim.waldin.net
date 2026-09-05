# container/

Source for the `twaldin/terminal-portfolio:latest` Docker image — the Ubuntu sandbox every visitor lands in. The backend names the tag exactly once, as `SANDBOX_POLICY.image` in `backend/sandbox-policy.js`, and `buildContainerSpec` passes it straight to `createContainer`; nothing checks that the image exists first, so a missing build shows up as container-create failures, not a startup warning. The same policy fixes the runtime posture the scripts rely on: `NetworkMode: none`, `CapDrop: ALL` with only `SETUID`/`SETGID` added back, `LANG`/`LC_ALL=C.UTF-8`, and `/tmp` as a 100 MB `noexec` tmpfs.

## Layout

```
container/
├── Dockerfile              # Ubuntu 24.04 → zsh + Oh My Posh + nvim nightly + scripts (see Image build)
├── build.sh                # Local `docker build` helper — no secret, no build args (see Image build)
├── AGENTS.md -> CLAUDE.md  # Symlink so both agent-guide names resolve here
├── DOS_Rebel.flf           # Incumbent banner font, copied to /usr/share/figlet/ so `figlet -f DOS_Rebel` resolves
├── blog/posts/             # 3 markdown posts with YAML frontmatter (copied to /home/portfolio/blog/; the frontend
│                           #   reads the same directory — see frontend/CLAUDE.md)
├── fonts/                  # Banner font pool: 24 .flf copied to /usr/share/figlet/custom/, one manifest line each
└── scripts/                # Copied to /home/portfolio/scripts/ (on PATH); top-level *.sh chmod +x at build
    ├── shared-functions.sh # Sourced by the page scripts, boot.sh, welcome.sh and .zshrc (theme.sh and the
    │                       #   animations are standalone): colour slots, emit_url / emit_scroll_top /
    │                       #   emit_navigate, pick_font_for_width, render_banner, print_centered, typewriter,
    │                       #   print_text, ascii_typewriter, create_box, hyperlink / email_link (OSC 8), git_activity
    ├── boot.sh             # Session intro: random animation + random width-appropriate font, theme flicker,
    │                       #   then exec welcome.sh (see Boot intro)
    ├── animations/         # braille-fire, starfield-warp, braille-plasma, logo-decode, font-cycle — one per boot
    ├── fonts.txt           # Font manifest `Display Name|width|height|flf`; boot and welcome pick by width class
    ├── welcome.sh          # Home page copy + menu box; prints its own banner only when run directly
    ├── theme.sh            # Theme picker: fzf live preview (OSC 9996), persist (OSC 9995)
    ├── themes.txt          # 463 theme names — must match the keys in frontend/src/config/themes.ts
    ├── projects.sh         # Project cards (2-up grid on wide terminals); sources also.sh for the dump at the bottom
    ├── also.sh             # Hackathon / archived / fork one-liners (print_also_list when sourced, full page when run)
    ├── flt.sh, agentelo.sh, hone.sh, harness.sh, stm32-games.sh,
    │   term-site.sh, trade-up-bot.sh, studyspot.sh, dotfiles.sh   # Pages for cloned repos: blurb + git_activity
    ├── tetrio-tui.sh, deck.sh, hone-a-drone.sh, gepa-ts.sh        # Pages for placeholder dirs: blurb only
    ├── about.sh            # About me
    ├── contact.sh          # Email + socials via OSC 8 hyperlinks
    ├── resume.sh           # Clickable link to https://tim.waldin.net/resume.pdf
    ├── blog.sh             # Post list + handoff to the HTML post page (see Blog)
    ├── gui.sh              # Hands off to the static /gui page (OSC 9997)
    └── help.sh             # Command list
```

## Image build (Dockerfile highlights)

- **Base / packages**: `ubuntu:24.04`. One apt layer installs bash, vim, neovim, nano, grep, ripgrep, fzf, less, bat (`batcat` symlinked to `bat`), git, unzip, tree, htop, procps, coreutils, findutils, ncurses-base, zsh, figlet, fontconfig, and creates the `portfolio` user with `/bin/zsh` as its shell. `curl`/`wget` are installed early for downloads; `wget` is purged at the end, `curl` is kept for mason.nvim's startup registry refresh (Dockerfile comment). `sudo` is installed in a late layer so busting it never rebuilds bob/nvim.
- **Markdown renderers**: mdcat 2.7.1 (amd64 only — skipped on arm64 builds) and glow 2.1.2 are installed, but nothing under `scripts/` runs either. `blog` hands off to the HTML page instead (see Blog).
- **Editor**: bob v4.1.6 → `bob install nightly && bob use nightly` (the dotfiles nvim config uses `vim.pack` and other nightly features). Plugins are baked in at build time — `yes A | timeout 300 …/bob/nvim-bin/nvim --headless +qa || true` — because runtime containers have no network; the `|| true` is deliberate: the Dockerfile expects mason's LSP-server fetches to fail during that run and treats it as harmless because `vim.pack` has already cloned the plugins. `typst-preview` is `sed`-stripped from `init.lua` first because it opens a system browser, which can't work in the sandbox.
- **Font**: JetBrains Mono Nerd Font v3.0.2 unzipped into `~/.local/share/fonts/` + `fc-cache`.
- **Prompt**: Oh My Posh installed to `~/.local/bin` (themes in `~/.local/share/themes`). `.zshrc` inits it with `~/.dotfiles/zsh/pure-modified.omp.json`, whose `{{ .UserName }}` is `sed`-replaced with `tim.waldin.net` so the prompt reads `tim.waldin.net ~`.
- **nvm** v0.40.1 (`PROFILE=/dev/null`), installed only so the dotfiles `load-nvmrc` hook resolves; the Dockerfile installs no Node version with it.
- **Repos** (one `RUN`, with an optional `github_token` build secret exported as `GITHUB_TOKEN` to lift bob's unauthenticated GitHub API rate limit): `twaldin/dotfiles` → `~/.dotfiles` (`~/.config/nvim` symlinks to its `nvim/`), and `~/projects/{flt,agentelo,stm32-games,term-site,trade-up-bot,hone,harness,studyspot}` cloned from `github.com/twaldin/<name>`. `~/projects/dotfiles` is a symlink to `~/.dotfiles`; `tetrio-tui`, `deck`, `hone-a-drone`, `gepa-ts` are empty `mkdir -p` placeholders, which is why their pages skip `git_activity`. Each project directory also gets a `<name>.sh` symlink (absolute target) to its script, plus `~/projects/also.sh`.
- **sudo**: passwordless for `portfolio` (`/etc/sudoers.d/portfolio`). Safe because the backend creates containers with `CapDrop: ALL` (only `SETUID`/`SETGID` added back), no network, and memory/pid limits — `sudo rm -rf /` works as a demo but can't escape.
- **Home extras**: `~/README.md` (a short "Welcome to Terminal Portfolio!" note), `~/portfolio/`, `~/workspace/`, `~/tmp/`. `~/.bashrc` also receives an older copy of the alias block (see Things to watch).
- **Star snapshot**: the last layer curls the GitHub API for the `hone` and `harness` `stargazers_count` into `~/.stars` (`ARG STARS_REFRESH` is the cache-buster; `|| true` keeps offline builds green). Nothing under `scripts/` reads that file today; the Dockerfile and `deploy.sh` comments still describe `welcome.sh` reading it.
- **Entrypoint**: `CMD /home/portfolio/secure-shell.sh`, which exports `HOME`/`USER`/`SHELL`, `cd`s home and `exec`s `/bin/zsh`. `ENV PATH` puts `~/.local/bin` and `~/scripts` first, so every top-level script also runs by name (`boot.sh` runs the animations through `bash`).
- **Building**: `build.sh` runs `docker build -t twaldin/terminal-portfolio:latest ./container` from the repo root with no secret and no build args. Production goes through the root `deploy.sh`, which adds `--secret id=github_token,src=/home/deploy/.github_token` (when that file exists) and `--build-arg STARS_REFRESH="$(date +%s)"` so each deploy rebuilds only the star layer. A `build.sh` image can therefore hit bob's rate limit and carries whatever `.stars` layer the cache had.

## Shell wiring (`.zshrc`)

The Dockerfile copies the dotfiles `zsh/zshrc` to `~/.zshrc` and appends:

1. `unsetopt PROMPT_CR` — no `%` partial-line marker in captured output.
2. The alias block below.
3. `source /home/portfolio/scripts/shared-functions.sh` (so `emit_url` exists in the interactive shell) and a `preexec` hook that pushes the browser URL for every typed command: return if the command is longer than 200 chars or outside `^[A-Za-z0-9 ._/+=:,@-]+$` (the same character set as `SAFE_CMD_RE` in `frontend/src/lib/websocket.ts` and the `_autoType` re-check in `backend/session.js`); return if the first word is one of `rm mv cp dd sudo su chmod chown kill pkill killall sh bash zsh dash eval exec source mkfs mount umount` — a container-only skip list, the frontend has no denylist and instead allowlists `NAVIGATION_COMMANDS`; `welcome`/`home` → `emit_url ""`; a project alias → `emit_url "projects/<alias>"`; anything else → `emit_url "${cmd// /%20}"`.
4. `PATH` prefix `~/.local/bin` and `eval "$(oh-my-posh init zsh --config ~/.dotfiles/zsh/pure-modified.omp.json)"`.

### Aliases

25 aliases; keep this table one-to-one with the `.zshrc` block in the Dockerfile. Every script path is `/home/portfolio/scripts/<name>.sh`.

| Alias | Runs |
|---|---|
| `home`, `welcome`, `boot` | `cd ~ && boot.sh` — all three replay the intro |
| `about`, `contact`, `resume` | `cd ~ && <name>.sh` |
| `projects`, `also` | `cd ~/projects && <name>.sh` |
| `flt`, `agentelo`, `stm32-games`, `term-site`, `trade-up-bot`, `hone`, `harness`, `studyspot`, `tetrio-tui`, `deck`, `hone-a-drone`, `gepa-ts` | `cd ~/projects/<name> && <name>.sh` |
| `dotfiles` | `cd ~/.dotfiles && dotfiles.sh` |
| `theme`, `help`, `blog`, `gui` | `<name>.sh` — no `cd` |

Adding a command means touching this block and `help.sh`, plus — if a URL should reach it — the frontend allowlists: `NAVIGATION_COMMANDS` in `frontend/src/lib/websocket.ts` lets the path auto-type the command, `KNOWN_COMMANDS` in `frontend/src/lib/routes.ts` lets it render instead of 404 (the two already differ for `theme` and `gui`; see `frontend/CLAUDE.md`). A new project alias additionally goes into both files' `PROJECT_ALIASES` sets and the `preexec` case that maps it to `projects/<alias>`.

## Boot intro (animations)

`boot` is what the frontend sends as `initCommand` for `/` (`pathToCommand` in `frontend/src/lib/websocket.ts`) and what `_maybeRunInitCommand` (`backend/session.js`) falls back to when the handshake carries no command; other allowlisted paths type their own command (`/about` → `about`), while a path that renders but fails `pathToCommand` (e.g. `/theme`) boots too. Every connect on `/` replays the intro, including resume/refresh — the backend never substitutes `welcome` (and the `welcome`/`home` aliases run `boot.sh` anyway); the animation and the welcome reveal are keypress-skippable instead.

`boot.sh` (`boot <anim>` forces an animation):

1. **Font** — `pick_font_for_width $((cols - 2))` picks a random `fonts.txt` line from the largest width class whose floor fits (67, 47, then 21 columns), else any font that fits. `render_banner twaldin <flf>` writes the trimmed figlet render to `/tmp/boot-banner.txt` (exported as `BOOT_BANNER_FILE`) and the display name to `/tmp/boot-font`. Fallbacks: stock `DOS_Rebel` at ≥ 62 columns, else the plain word `twaldin`.
2. **Animation** — random pick from `ANIMATIONS`. If it is in `FLICKER_OK` (all but `braille-fire`, whose 256-colour gradient needs a stable palette) a background loop prints `OSC 9996 next` every 0.45 s so the frontend cycles its flicker pairs.
3. **Handoff** — kill the flicker loop, drain buffered keypresses (`read -rsn1 -t 0.05` loop: a burst typed mid-intro would otherwise run as a mangled command), send `OSC 9996` with an empty payload to restore the saved theme, then `WELCOME_SKIP_BANNER=1 exec bash welcome.sh`.

Animation end-contract (the "v3" header comment in each script): banner text comes from `$BOOT_BANNER_FILE` (3–11 rows, width ≤ cols − 2; when it is empty four of the scripts fall back to figlet `DOS_Rebel`, `font-cycle` to its own stock-font pool); never `\033[2J` — scroll the prompt into scrollback and animate in place; finish with the banner pinned to row 1, the cursor parked exactly one row below it, SGR reset, autowrap and cursor restored, exit 0. Scrollback then reads prompt → banner → welcome. `braille-fire`, `braille-plasma` and `font-cycle` export `LC_ALL=C.UTF-8` because `wc -L` counts bytes otherwise; `starfield-warp` and `logo-decode` normalise the banner to one byte per display cell because mawk is byte-based.

`welcome.sh` runs `emit_url "welcome"` first, so the URL settles on `/welcome` after every intro. Its own centred banner (`print_banner`, preferring the font in `/tmp/boot-font` if it still fits the current width) only prints when `WELCOME_SKIP_BANNER` is unset — i.e. when the script is run directly. The copy and menu box reveal line by line (`WELCOME_PACE_COPY` / `_BOX` / `_BLANK`); a keypress on `/dev/tty` skips to instant and drains the burst.

## Blog

`blog.sh` reads `/home/portfolio/blog/posts/*.md` and their frontmatter `date` / `title`:

- `blog` / `blog list` — posts newest first, each slug an OSC 8 hyperlink to `https://tim.waldin.net/blog/<slug>`, titles truncated so a row fits the terminal width when there is room for one, then `emit_scroll_top`.
- `blog <slug>`, `blog <N>` (1 = newest), `blog <substring>` (case-insensitive; must match exactly one slug, otherwise the candidates are listed), `blog latest` — `render_post` resolves the slug and calls `emit_navigate "/blog/<slug>"`: the browser leaves the terminal for the static post page (`frontend/src/app/blog/[slug]/page.tsx`). Nothing is rendered in the PTY; mdcat and glow are not involved. The static page hands back to the live terminal through `/t/<cmd>` (see `frontend/CLAUDE.md`).
- `blog --raw <slug>` — prints the markdown body without frontmatter for piping; the slug must match `^[A-Za-z0-9._-]+$`.

## Terminal control sequences

Emitters live in `shared-functions.sh` and terminate with ST (`\033\\`); `theme.sh` and `boot.sh` write their theme sequences inline with BEL (`\007`). Handlers are registered with `xterm.parser.registerOscHandler` in `frontend/src/components/Terminal.tsx`.

| Sequence | Emitted by | Frontend |
|---|---|---|
| `OSC 9999 ; <path>` | `emit_url` — page and project scripts except `blog`, `gui`, `theme`; `preexec` | `history.pushState('/<path>')`, no reload |
| `OSC 9998` | `emit_scroll_top` — `blog`, `projects`, `also` | `xterm.scrollToTop()` so long output starts at its first line |
| `OSC 9997 ; <path>` | `emit_navigate` — `blog <slug>`, `gui` | `location.assign` to the same-origin path (full page navigation) |
| `OSC 9996 ; <name>` / `next` / empty | `theme.sh` preview, `boot.sh` flicker and restore | ephemeral theme; `next` steps the flicker pairs; empty restores the saved theme |
| `OSC 9995 ; <name>` / `dark` / `light` / `reset` | `theme.sh` | persist the theme, switch mode, or reset |
| `OSC 8` | `hyperlink`, `email_link`, the `blog` list | clickable links; `http`, `https`, `mailto` only |

URL conventions for OSC 9999: page scripts push their own command name (`about`, `contact`, `resume`, `help`, `projects`, `welcome`) and project scripts push `projects/<name>`. `blog`, `gui` and `theme` push nothing themselves, so their URL is whatever `preexec` pushed (`/blog`, `/blog%20foo`, `/gui`, `/theme` — mapping under Shell wiring). `preexec` fires first, so a script's own `emit_url` wins (`boot`: `/boot`, then `/welcome`). Refreshing on such a path re-runs the command only if it passes the frontend allowlist.

## Things to watch

- The `term-site` clone is guarded with `(git clone … || mkdir -p term-site)` from when the repo was private. `twaldin/term-site` now redirects to the public `twaldin/tim.waldin.net`, so the clone succeeds and the visitor's `term-site` page shows live git activity; the guard is dormant.
- A later `RUN` writes a second alias block to `~/.bashrc`, missing `hone`, `harness`, `studyspot`, `blog` and `gui`. The visitor's shell is zsh (`useradd -s /bin/zsh`; `secure-shell.sh` execs `/bin/zsh`), so that block is only read when a visitor starts an interactive `bash`.
- The Dockerfile's `preexec` comment says the frontend's URL → command mapping uses "the same char whitelist + BLOCKED_HEADS"; the frontend has no such list (see Shell wiring).
- `help.sh` lists four animations for `boot <name>`; `ANIMATIONS` in `boot.sh` has five (`font-cycle` is missing from help).
