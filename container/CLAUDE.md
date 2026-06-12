# container/

Source for the `twaldin/terminal-portfolio:latest` Docker image — the Ubuntu sandbox that every visitor lands in. Built with `container/build.sh` (`docker build -t twaldin/terminal-portfolio:latest ./container`). The backend's `SessionManager` looks up this exact tag in `backend/session.js:240` and warns on startup if it's missing.

## Layout

```
container/
├── Dockerfile              # Ubuntu 24.04 → zsh + Oh My Posh + nvim nightly + scripts
├── build.sh                # docker build helper
├── DOS_Rebel.flf           # Custom figlet font (copied to /usr/share/figlet/)
├── Univers.flf
├── blog/posts/             # Markdown blog posts (copied to /home/portfolio/blog/)
└── scripts/                # Portfolio shell scripts (copied to /home/portfolio/scripts/)
    ├── shared-functions.sh # colors, typewriter, ascii_typewriter, create_box, emit_url
    ├── welcome.sh          # Home page (figlet "twaldin" + portfolio menu box)
    ├── auto-welcome.sh
    ├── projects.sh         # List of projects with descriptions
    ├── about.sh            # About me
    ├── contact.sh          # Email + socials via OSC 8 hyperlinks
    ├── resume.sh           # Resume page with clickable PDF link
    ├── blog.sh             # Markdown rendering via mdcat (fallback: glow)
    ├── help.sh             # Available commands
    └── flt.sh, agentelo.sh, hone.sh, harness.sh,
        stm32-games.sh, term-site.sh, trade-up-bot.sh,
        dotfiles.sh                    # Per-project pages
```

## Image build (Dockerfile highlights)

- **Base**: `ubuntu:24.04`. Packages installed in one layer for cache efficiency: zsh, neovim, vim, nano, ripgrep, fzf, less, bat, git, tree, htop, figlet, fontconfig.
- **Markdown**: `mdcat` (primary; emits OSC 8 hyperlinks so xterm.js renders clickable link text without printing the raw URL) and `glow` as fallback. `blog.sh` prefers `mdcat` when both are present.
- **Editor**: `bob` neovim version manager → `bob install nightly` (the dotfiles nvim config uses `vim.pack` and other nightly features). Plugins are baked into the image at build time (`yes A | nvim --headless +qa`) because the runtime container has `NetworkMode: none`.
- **Font**: JetBrains Mono Nerd Font v3.0.2 installed under `~/.local/share/fonts/`.
- **Prompt**: Oh My Posh + the `pure-modified.omp.json` from the dotfiles repo, with `{{ .UserName }}` `sed`-replaced to `tim.waldin.net` so the prompt reads `tim.waldin.net ~`.
- **Repos**: dotfiles + project repos cloned into `/home/portfolio/projects/` at build time. Each repo gets a per-script symlink (`projects/flt/flt.sh -> ../../scripts/flt.sh`, etc.) so the navigation aliases work from inside the project dir.
- **sudo**: passwordless `sudo` for `portfolio`. Safe because all Linux capabilities are dropped at the Docker level — `sudo rm -rf /` works inside the container as a demo, but can't escape.

## Shell wiring (`.zshrc`)

The Dockerfile builds a custom `.zshrc` that:

1. `source`s the dotfiles `zshrc`, then disables `PROMPT_CR` (zsh's partial-line `%` marker) for cleaner output.
2. Defines aliases for every portfolio command (`welcome`, `home`, `projects`, `about`, `contact`, `resume`, `blog`, `help`, plus per-project aliases like `flt`, `agentelo`, `term-site`, `stm32-games`, etc.). Each alias `cd`s into the right directory and runs the corresponding script.
3. Loads `shared-functions.sh` for `emit_url` (the OSC 9999 emitter).
4. Defines a `preexec` hook that re-emits an OSC 9999 URL before every typed command so the browser URL tracks whatever the user typed. Same `SAFE_CMD_RE` and blocked-heads list as the frontend's `pathToCommand` (`websocket.ts`) — keep the two in sync.
5. Initialises Oh My Posh with `pure-modified.omp.json`.

## URL emission protocol

Scripts and `preexec` write `\033]9999;<path>\007` to stdout via `emit_url` (defined in `shared-functions.sh`). The frontend's `OSC 9999` handler (`frontend/src/components/Terminal.tsx:99`) calls `history.pushState` with that path. Conventions:

- `welcome` / `home` → empty path (`/`).
- Project aliases → `projects/<alias>` (matches the legacy pretty URL the frontend recognises).
- Anything else → URL-encoded raw command (`emit_url "${cmd// /%20}"`).

## Things to watch

- `term-site` is a private repo at clone time — the Dockerfile masks the failure with `(git clone ... || mkdir -p term-site)`. If the project is made public, the visitor's `term-site` page will pick up live git activity automatically.
- `typst-preview.nvim` is `sed`-stripped from the dotfiles nvim init at build time because it spawns a system browser, which can't work in a sandbox with no network.
- Mason LSP server fetches fail at build time (`curl` is missing in mason's runtime path) — harmless, plugins are still cloned via `vim.pack`. The `|| true` on the mason install RUN line is intentional.
- `nvm` is installed so the dotfiles `load-nvmrc` hook resolves; we don't actually need a Node runtime in the container.
