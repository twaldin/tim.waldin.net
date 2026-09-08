FROM ubuntu:24.04

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Set proper terminal environment for Gruvbox Dark colors
ENV TERM=xterm-256color
ENV COLORTERM=truecolor

# Ubuntu's base sources already include universe. Keep the tools used by
# portfolio scripts, repository browsing, the editor and the shell demo.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl bash grep ripgrep fzf less git unzip tree htop \
    procps coreutils findutils ncurses-base zsh figlet sudo && \
    useradd -m -s /bin/zsh -d /home/portfolio portfolio && \
    rm -rf /var/lib/apt/lists/*

# Copy all scripts
COPY scripts/ /home/portfolio/scripts/
# Copy blog posts (read by /home/portfolio/scripts/blog.sh)
COPY blog/ /home/portfolio/blog/
COPY DOS_Rebel.flf /usr/share/figlet/DOS_Rebel.flf
# Curated legible font pool for the boot banner (see scripts/fonts.txt).
COPY fonts/ /usr/share/figlet/custom/

# Create writable directories for user data
# NOTE: /home/portfolio/.config/nvim is NOT pre-created; it becomes a symlink
# to /home/portfolio/.dotfiles/nvim once the dotfiles repo is cloned below.
RUN mkdir -p /home/portfolio/.config && \
    mkdir -p /home/portfolio/.local/share && \
    mkdir -p /home/portfolio/.local/state && \
    mkdir -p /home/portfolio/.local/bin && \
    mkdir -p /home/portfolio/.cache && \
    mkdir -p /home/portfolio/workspace && \
    mkdir -p /home/portfolio/tmp

# Install bob (neovim version manager) — needed because the dotfiles nvim
# config uses nightly features (vim.pack, etc.) that aren't in Ubuntu's
# stable neovim package.
RUN ARCH=$(dpkg --print-architecture) && \
    case "$ARCH" in amd64) BARCH="x86_64" ;; arm64) BARCH="arm" ;; *) BARCH="$ARCH" ;; esac && \
    curl -sL "https://github.com/MordechaiHadad/bob/releases/download/v4.1.6/bob-linux-${BARCH}.zip" \
      -o /tmp/bob.zip && \
    unzip -q /tmp/bob.zip -d /tmp/bob && \
    mv /tmp/bob/bob-linux-${BARCH}/bob /usr/local/bin/bob && \
    chmod +x /usr/local/bin/bob && \
    rm -rf /tmp/bob /tmp/bob.zip && \
    bob --version

# Set proper ownership for all user directories
RUN chown -R portfolio:portfolio /home/portfolio/.config && \
    chown -R portfolio:portfolio /home/portfolio/.local && \
    chown -R portfolio:portfolio /home/portfolio/workspace && \
    chown -R portfolio:portfolio /home/portfolio/tmp

# Switch to portfolio user to install Oh My Posh
USER portfolio
WORKDIR /home/portfolio

# Only the dotfiles prompt is used; do not install the bundled theme collection.
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://cdn.ohmyposh.dev/releases/latest/posh-linux-${ARCH}" \
      -o /home/portfolio/.local/bin/oh-my-posh && \
    chmod +x /home/portfolio/.local/bin/oh-my-posh && \
    /home/portfolio/.local/bin/oh-my-posh version

# Clone dotfiles and project repositories directly into container
# GITHUB_TOKEN via build secret lifts bob's GitHub API rate limit (bob queries
# the API unauthenticated otherwise, which rate-limits busy IPs on rebuild).
# Build: docker build --secret id=github_token,src=<token-file> ...
RUN --mount=type=secret,id=github_token,required=false,mode=0644 \
    tok="$(cat /run/secrets/github_token 2>/dev/null || true)" && \
    if [ -n "$tok" ]; then export GITHUB_TOKEN="$tok"; fi && \
    git clone https://github.com/twaldin/dotfiles.git /home/portfolio/.dotfiles && \
    ln -sf /home/portfolio/.dotfiles/nvim /home/portfolio/.config/nvim && \
    # The OMP template renders `{{ .UserName }} {{ .Path }}` — replace the
    # session-segment UserName with a literal "tim.waldin.net" so the prompt
    # reads "tim.waldin.net ~" instead of "portfolio ~". We only touch the
    # template string in the session segment, leaving everything else alone.
    sed -i 's|{{ .UserName }}|tim.waldin.net|g' /home/portfolio/.dotfiles/zsh/pure-modified.omp.json && \
    # Strip typst-preview.nvim from the dotfiles init — it opens a system
    # browser for its live preview, which can't work inside the sandboxed
    # session container. Safe to drop without touching Tim's real dotfiles.
    sed -i '/typst-preview/d' /home/portfolio/.dotfiles/nvim/init.lua && \
    bob install nightly && \
    bob use nightly && \
    # vim.pack restores locked plugins even after their init.lua lines are removed.
    /home/portfolio/.local/share/bob/nvim-bin/nvim --clean --headless \
      -c 'lua local p=vim.fn.expand("~/.config/nvim/nvim-pack-lock.json"); local lock=vim.json.decode(table.concat(vim.fn.readfile(p), "\n")); lock.plugins["typst-preview.nvim"]=nil; vim.fn.writefile({vim.json.encode(lock)}, p)' \
      -c qa && \
    mkdir -p /home/portfolio/projects && \
    cd /home/portfolio/projects && \
    git clone https://github.com/twaldin/flt.git && \
    git clone https://github.com/twaldin/agentelo.git && \
    git clone https://github.com/twaldin/stm32-games.git && \
    (git clone https://github.com/twaldin/term-site.git || mkdir -p term-site) && \
    git clone https://github.com/twaldin/trade-up-bot.git && \
    git clone https://github.com/twaldin/hone.git && \
    git clone https://github.com/twaldin/harness.git && \
    git clone https://github.com/twaldin/studyspot.git && \
    ln -sf /home/portfolio/scripts/flt.sh /home/portfolio/projects/flt/flt.sh && \
    ln -sf /home/portfolio/scripts/agentelo.sh /home/portfolio/projects/agentelo/agentelo.sh && \
    ln -sf /home/portfolio/scripts/stm32-games.sh /home/portfolio/projects/stm32-games/stm32-games.sh && \
    ln -sf /home/portfolio/scripts/term-site.sh /home/portfolio/projects/term-site/term-site.sh && \
    ln -sf /home/portfolio/scripts/trade-up-bot.sh /home/portfolio/projects/trade-up-bot/trade-up-bot.sh && \
    ln -sf /home/portfolio/scripts/hone.sh /home/portfolio/projects/hone/hone.sh && \
    ln -sf /home/portfolio/scripts/harness.sh /home/portfolio/projects/harness/harness.sh && \
    ln -sf /home/portfolio/scripts/studyspot.sh /home/portfolio/projects/studyspot/studyspot.sh && \
    ln -sf /home/portfolio/scripts/dotfiles.sh /home/portfolio/.dotfiles/dotfiles.sh && \
    ln -sf /home/portfolio/.dotfiles /home/portfolio/projects/dotfiles && \
    mkdir -p /home/portfolio/projects/tetrio-tui \
             /home/portfolio/projects/deck \
             /home/portfolio/projects/hone-a-drone \
             /home/portfolio/projects/gepa-ts && \
    ln -sf /home/portfolio/scripts/tetrio-tui.sh /home/portfolio/projects/tetrio-tui/tetrio-tui.sh && \
    ln -sf /home/portfolio/scripts/deck.sh /home/portfolio/projects/deck/deck.sh && \
    ln -sf /home/portfolio/scripts/hone-a-drone.sh /home/portfolio/projects/hone-a-drone/hone-a-drone.sh && \
    ln -sf /home/portfolio/scripts/gepa-ts.sh /home/portfolio/projects/gepa-ts/gepa-ts.sh && \
    ln -sf /home/portfolio/scripts/also.sh /home/portfolio/projects/also.sh

# Pre-install nvim plugins declared in dotfiles/nvim/init.lua (vim.pack.add).
# Container has no internet at runtime, so plugins must be baked into the
# image. Uses bob's nightly nvim directly (PATH tricks don't apply here —
# .zshrc isn't installed at this build step yet). `yes A` auto-accepts
# vim.pack's confirmation prompt. Optional editor-tool downloads may fail;
# tolerate that here and verify offline editor startup against the built image.
RUN yes A | timeout 300 /home/portfolio/.local/share/bob/nvim-bin/nvim --headless +qa || true
RUN ls /home/portfolio/.local/share/nvim/site/pack/core/opt | head -20

# Container-owned startup avoids workstation-only aliases and nvm hooks.
COPY --chown=portfolio:portfolio zshrc /home/portfolio/.zshrc
COPY --chown=portfolio:portfolio shell-aliases.sh /home/portfolio/.portfolio-aliases

# Switch back to root to continue setup
USER root

# Passwordless sudo is part of the isolated visitor shell demo.
RUN echo 'portfolio ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/portfolio && \
    chmod 440 /etc/sudoers.d/portfolio

# Create directory structure for portfolio content
RUN mkdir -p /home/portfolio/portfolio && \
    chown -R portfolio:portfolio /home/portfolio

# Add welcome message and basic portfolio content
RUN echo "Welcome to Terminal Portfolio!" > /home/portfolio/README.md && \
    echo "" >> /home/portfolio/README.md && \
    echo "This is a secure containerized terminal environment." >> /home/portfolio/README.md && \
    echo "You can run any command here - try 'ls', 'help', or even 'rm -rf /'!" >> /home/portfolio/README.md && \
    echo "" >> /home/portfolio/README.md && \
    echo "Available commands:" >> /home/portfolio/README.md && \
    echo "  ls, ll, la - List files" >> /home/portfolio/README.md && \
    echo "  cat - View file contents" >> /home/portfolio/README.md && \
    echo "  nvim (also vi, vim) - Edit files" >> /home/portfolio/README.md && \
    echo "  grep, rg - Search text" >> /home/portfolio/README.md && \
    echo "  fzf - Fuzzy file finder" >> /home/portfolio/README.md && \
    echo "  tree - Show directory structure" >> /home/portfolio/README.md && \
    echo "  htop - System monitor" >> /home/portfolio/README.md

# Set execute permissions for scripts
RUN chmod +x /home/portfolio/scripts/*.sh


# Create basic directory structure (empty but functional)
RUN mkdir -p /home/portfolio

# Bash remains available, with the same supported navigation as zsh.
RUN echo 'source /home/portfolio/.portfolio-aliases' >> /home/portfolio/.bashrc

# Set proper ownership
RUN chown -R portfolio:portfolio /home/portfolio

# COPY preserves checkout modes; visitors must be able to read every banner font.
RUN chmod -R a+rX /usr/share/figlet

# Create a restricted shell environment
RUN echo '#!/bin/zsh' > /home/portfolio/secure-shell.sh && \
    echo 'export HOME=/home/portfolio' >> /home/portfolio/secure-shell.sh && \
    echo 'export USER=portfolio' >> /home/portfolio/secure-shell.sh && \
    echo 'export SHELL=/bin/zsh' >> /home/portfolio/secure-shell.sh && \
    echo 'cd /home/portfolio' >> /home/portfolio/secure-shell.sh && \
    echo '# Navigation aliases are loaded in .zshrc' >> /home/portfolio/secure-shell.sh && \
    echo 'exec /bin/zsh' >> /home/portfolio/secure-shell.sh && \
    chmod +x /home/portfolio/secure-shell.sh && \
    chown portfolio:portfolio /home/portfolio/secure-shell.sh

# Switch to non-root user and set working directory
USER portfolio
WORKDIR /home/portfolio

# Set environment variables for security
ENV HOME=/home/portfolio
ENV USER=portfolio
ENV SHELL=/bin/zsh
ENV PATH=/home/portfolio/.local/share/bob/nvim-bin:/home/portfolio/.local/bin:/home/portfolio/scripts:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV EDITOR=nvim

# Default command starts secure shell
CMD ["/home/portfolio/secure-shell.sh"]
