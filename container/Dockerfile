FROM ubuntu:24.04

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Set proper terminal environment for Gruvbox Dark colors
ENV TERM=xterm-256color
ENV COLORTERM=truecolor

# Update package lists and install basic packages first
RUN apt-get update --fix-missing && \
    apt-get install -y ca-certificates apt-transport-https software-properties-common

# Add universe repository and update again
RUN add-apt-repository universe && apt-get update

# Install curl and wget for downloading packages (removed later)
RUN apt-get install -y curl wget

# Install all required packages in one layer
RUN apt-get install -y \
    bash \
    vim \
    neovim \
    nano \
    grep \
    ripgrep \
    fzf \
    less \
    bat \
    git \
    unzip \
    tree \
    htop \
    procps \
    coreutils \
    findutils \
    ncurses-base \
    zsh \
    figlet \
    fontconfig \
    && useradd -m -s /bin/zsh -d /home/portfolio portfolio \
    && mkdir -p /home/portfolio/.bashrc.d \
    && ln -s /usr/bin/batcat /usr/bin/bat 2>/dev/null || true \
    && rm -rf /var/lib/apt/lists/*

# Copy all scripts
COPY scripts/ /home/portfolio/scripts/
# Copy blog posts (read by /home/portfolio/scripts/blog.sh)
COPY blog/ /home/portfolio/blog/
COPY DOS_Rebel.flf /usr/share/figlet/DOS_Rebel.flf

# Install mdcat (primary markdown renderer). mdcat emits OSC 8 hyperlinks so
# xterm.js in the browser renders clickable link TEXT without printing the raw
# URL next to it — glow doesn't do this, it prints both. Also no pager needed:
# xterm.js handles scroll natively, which sidesteps glow's `-p` alt-screen
# redraw duplication bug on viewport resize.
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then \
      MDCAT_ARCH=x86_64-unknown-linux-gnu && \
      curl -fsSL "https://github.com/swsnr/mdcat/releases/download/mdcat-2.7.1/mdcat-2.7.1-${MDCAT_ARCH}.tar.gz" \
        | tar -xz -C /tmp && \
      mv /tmp/mdcat-2.7.1-${MDCAT_ARCH}/mdcat /usr/local/bin/mdcat && \
      rm -rf /tmp/mdcat-2.7.1-${MDCAT_ARCH} && \
      chmod +x /usr/local/bin/mdcat && \
      mdcat --version; \
    else \
      echo "Skipping mdcat on non-amd64 architecture"; \
    fi

# Install glow (markdown renderer) as fallback. blog.sh prefers mdcat when
# both are present.
RUN ARCH=$(dpkg --print-architecture) && \
    curl -sL "https://github.com/charmbracelet/glow/releases/download/v2.1.2/glow_2.1.2_${ARCH}.deb" \
      -o /tmp/glow.deb && \
    dpkg -i /tmp/glow.deb && \
    rm /tmp/glow.deb && \
    glow --version

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

# Install JetBrains Mono Nerd Font
RUN mkdir -p /home/portfolio/.local/share/fonts && \
    cd /tmp && \
    wget https://github.com/ryanoasis/nerd-fonts/releases/download/v3.0.2/JetBrainsMono.zip && \
    unzip JetBrainsMono.zip -d /home/portfolio/.local/share/fonts/ && \
    rm JetBrainsMono.zip && \
    fc-cache -fv

# Install Oh My Posh
RUN mkdir -p /home/portfolio/.local/share/themes && \
    curl -s https://ohmyposh.dev/install.sh | bash -s -- -d /home/portfolio/.local/bin -t /home/portfolio/.local/share/themes

# Install nvm — the dotfiles zshrc defines a `load-nvmrc` hook that calls
# `nvm_find_nvmrc` unconditionally on shell init. Without nvm installed,
# the function is undefined and zsh prints 'command not found' on every
# new session. We don't need a specific Node version in the container, just
# the nvm.sh so the hook's helpers resolve.
RUN curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | PROFILE=/dev/null bash

# Clone dotfiles and project repositories directly into container
# Note: term-site is private — clone will fail silently, make it public to fix
RUN git clone https://github.com/twaldin/dotfiles.git /home/portfolio/.dotfiles && \
    ln -sf /home/portfolio/.dotfiles/nvim /home/portfolio/.config/nvim && \
    ln -sf /home/portfolio/.dotfiles/zsh/pure-modified.omp.json && \
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
    mkdir -p /home/portfolio/projects && \
    cd /home/portfolio/projects && \
    git clone https://github.com/twaldin/flt.git && \
    git clone https://github.com/twaldin/agentelo.git && \
    git clone https://github.com/twaldin/stm32-games.git && \
    (git clone https://github.com/twaldin/term-site.git || mkdir -p term-site) && \
    git clone https://github.com/twaldin/trade-up-bot.git && \
    git clone https://github.com/twaldin/hone.git && \
    git clone https://github.com/twaldin/harness.git && \
    ln -sf /home/portfolio/scripts/flt.sh /home/portfolio/projects/flt/flt.sh && \
    ln -sf /home/portfolio/scripts/agentelo.sh /home/portfolio/projects/agentelo/agentelo.sh && \
    ln -sf /home/portfolio/scripts/stm32-games.sh /home/portfolio/projects/stm32-games/stm32-games.sh && \
    ln -sf /home/portfolio/scripts/term-site.sh /home/portfolio/projects/term-site/term-site.sh && \
    ln -sf /home/portfolio/scripts/trade-up-bot.sh /home/portfolio/projects/trade-up-bot/trade-up-bot.sh && \
    ln -sf /home/portfolio/scripts/hone.sh /home/portfolio/projects/hone/hone.sh && \
    ln -sf /home/portfolio/scripts/harness.sh /home/portfolio/projects/harness/harness.sh && \
    ln -sf /home/portfolio/scripts/dotfiles.sh /home/portfolio/.dotfiles/dotfiles.sh && \
    ln -sf /home/portfolio/.dotfiles /home/portfolio/projects/dotfiles

# Pre-install nvim plugins declared in dotfiles/nvim/init.lua (vim.pack.add).
# Container has no internet at runtime, so plugins must be baked into the
# image. Uses bob's nightly nvim directly (PATH tricks don't apply here —
# .zshrc isn't installed at this build step yet). `yes A` auto-accepts
# vim.pack's confirmation prompt. mason's LSP-server fetches will fail
# (curl not installed in its runtime path) — harmless, plugins themselves
# get cloned via git, so we mask the nonzero exit with || true.
RUN yes A | timeout 300 /home/portfolio/.local/share/bob/nvim-bin/nvim --headless +qa || true
RUN ls /home/portfolio/.local/share/nvim/site/pack/core/opt | head -20

# Create custom .zshrc with navigation aliases
RUN cp /home/portfolio/.dotfiles/zsh/zshrc /home/portfolio/.zshrc && \
    echo "" >> /home/portfolio/.zshrc && \
    echo "# Suppress zsh partial-line marker (%)" >> /home/portfolio/.zshrc && \
    echo "unsetopt PROMPT_CR" >> /home/portfolio/.zshrc && \
    echo "" >> /home/portfolio/.zshrc && \
    echo "# Portfolio navigation aliases" >> /home/portfolio/.zshrc && \
    echo "alias projects='cd ~/projects && /home/portfolio/scripts/projects.sh'" >> /home/portfolio/.zshrc && \
    echo "alias flt='cd ~/projects/flt && /home/portfolio/scripts/flt.sh'" >> /home/portfolio/.zshrc && \
    echo "alias agentelo='cd ~/projects/agentelo && /home/portfolio/scripts/agentelo.sh'" >> /home/portfolio/.zshrc && \
    echo "alias stm32-games='cd ~/projects/stm32-games && /home/portfolio/scripts/stm32-games.sh'" >> /home/portfolio/.zshrc && \
    echo "alias term-site='cd ~/projects/term-site && /home/portfolio/scripts/term-site.sh'" >> /home/portfolio/.zshrc && \
    echo "alias trade-up-bot='cd ~/projects/trade-up-bot && /home/portfolio/scripts/trade-up-bot.sh'" >> /home/portfolio/.zshrc && \
    echo "alias hone='cd ~/projects/hone && /home/portfolio/scripts/hone.sh'" >> /home/portfolio/.zshrc && \
    echo "alias harness='cd ~/projects/harness && /home/portfolio/scripts/harness.sh'" >> /home/portfolio/.zshrc && \
    echo "alias dotfiles='cd ~/.dotfiles && /home/portfolio/scripts/dotfiles.sh'" >> /home/portfolio/.zshrc && \
    echo "alias home='cd ~ && /home/portfolio/scripts/welcome.sh'" >> /home/portfolio/.zshrc && \
    echo "alias welcome='cd ~ && /home/portfolio/scripts/welcome.sh'" >> /home/portfolio/.zshrc && \
    echo "alias contact='cd ~ && /home/portfolio/scripts/contact.sh'" >> /home/portfolio/.zshrc && \
    echo "alias about='cd ~ && /home/portfolio/scripts/about.sh'" >> /home/portfolio/.zshrc && \
    echo "alias help='/home/portfolio/scripts/help.sh'" >> /home/portfolio/.zshrc && \
    echo "alias resume='cd ~ && /home/portfolio/scripts/resume.sh'" >> /home/portfolio/.zshrc && \
    echo "alias blog='/home/portfolio/scripts/blog.sh'" >> /home/portfolio/.zshrc && \
    echo "" >> /home/portfolio/.zshrc && \
    echo "# preexec — re-emit OSC 9999 URL before every typed command so the" >> /home/portfolio/.zshrc && \
    echo "# browser URL tracks literally whatever the user typed. The frontend" >> /home/portfolio/.zshrc && \
    echo "# URL → command mapping uses the same char whitelist + BLOCKED_HEADS," >> /home/portfolio/.zshrc && \
    echo "# so the two directions stay in sync." >> /home/portfolio/.zshrc && \
    echo "source /home/portfolio/scripts/shared-functions.sh" >> /home/portfolio/.zshrc && \
    echo "preexec() {" >> /home/portfolio/.zshrc && \
    echo "  local cmd=\$1" >> /home/portfolio/.zshrc && \
    echo "  (( \${#cmd} > 200 )) && return" >> /home/portfolio/.zshrc && \
    echo "  # Safe char set — matches frontend SAFE_CMD_RE." >> /home/portfolio/.zshrc && \
    echo "  [[ \"\$cmd\" =~ '^[A-Za-z0-9 ._/+=:,@-]+$' ]] || return" >> /home/portfolio/.zshrc && \
    echo "  local first=\${cmd%% *}" >> /home/portfolio/.zshrc && \
    echo "  case \"\$first\" in" >> /home/portfolio/.zshrc && \
    echo "    rm|mv|cp|dd|sudo|su|chmod|chown|kill|pkill|killall|sh|bash|zsh|dash|eval|exec|source|mkfs|mount|umount) return ;;" >> /home/portfolio/.zshrc && \
    echo "  esac" >> /home/portfolio/.zshrc && \
    echo "  # Keyword shortcuts: map project aliases to the /projects/<name>" >> /home/portfolio/.zshrc && \
    echo "  # pretty URL instead of the raw alias name." >> /home/portfolio/.zshrc && \
    echo "  case \"\$cmd\" in" >> /home/portfolio/.zshrc && \
    echo "    welcome|home)         emit_url \"\"; return ;;" >> /home/portfolio/.zshrc && \
    echo "    flt|agentelo|hone|harness|term-site|trade-up-bot|stm32-games|dotfiles)" >> /home/portfolio/.zshrc && \
    echo "                          emit_url \"projects/\$cmd\"; return ;;" >> /home/portfolio/.zshrc && \
    echo "  esac" >> /home/portfolio/.zshrc && \
    echo "  # Universal: url-encode spaces, leave everything else literal." >> /home/portfolio/.zshrc && \
    echo "  emit_url \"\${cmd// /%20}\"" >> /home/portfolio/.zshrc && \
    echo "}" >> /home/portfolio/.zshrc && \
    echo "" >> /home/portfolio/.zshrc && \
    echo "# Oh My Posh configuration - override dotfiles config" >> /home/portfolio/.zshrc && \
    echo "export PATH=\"/home/portfolio/.local/bin:\$PATH\"" >> /home/portfolio/.zshrc && \
    echo "eval \"\$(/home/portfolio/.local/bin/oh-my-posh init zsh --config /home/portfolio/.dotfiles/zsh/pure-modified.omp.json)\"" >> /home/portfolio/.zshrc && \
    chown portfolio:portfolio /home/portfolio/.zshrc

# Switch back to root to continue setup
USER root

# Remove wget (no longer needed). Keep curl — mason.nvim spawns curl at
# startup to refresh LSP server registry; without it nvim pops a
# "Press ENTER or type command to continue" prompt on every launch.
# Install sudo here (not in the early layer) to avoid busting the bob/nvim
# build cache. Passwordless sudo lets visitors run sudo rm -rf / as a demo;
# all Linux capabilities are still dropped at Docker level so root inside the
# container can't escape or affect the host.
RUN apt-get purge -y wget && \
    apt-get autoremove -y && \
    apt-get update && apt-get install -y sudo && \
    rm -rf /var/lib/apt/lists/* && \
    echo 'portfolio ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/portfolio && \
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
    echo "  cat, bat - View file contents" >> /home/portfolio/README.md && \
    echo "  nvim, nano - Edit files" >> /home/portfolio/README.md && \
    echo "  grep, rg - Search text" >> /home/portfolio/README.md && \
    echo "  fzf - Fuzzy file finder" >> /home/portfolio/README.md && \
    echo "  tree - Show directory structure" >> /home/portfolio/README.md && \
    echo "  htop - System monitor" >> /home/portfolio/README.md

# Set execute permissions for scripts
RUN chmod +x /home/portfolio/scripts/*.sh


# Create basic directory structure (empty but functional)
RUN mkdir -p /home/portfolio

# Add PATH for scripts and portfolio aliases
RUN echo 'export PATH="/home/portfolio/scripts:$PATH"' >> /home/portfolio/.bashrc && \
    echo "# Portfolio navigation aliases" >> /home/portfolio/.bashrc && \
    echo "alias projects='cd ~/projects && /home/portfolio/scripts/projects.sh'" >> /home/portfolio/.bashrc && \
    echo "alias flt='cd ~/projects/flt && /home/portfolio/scripts/flt.sh'" >> /home/portfolio/.bashrc && \
    echo "alias agentelo='cd ~/projects/agentelo && /home/portfolio/scripts/agentelo.sh'" >> /home/portfolio/.bashrc && \
    echo "alias stm32-games='cd ~/projects/stm32-games && /home/portfolio/scripts/stm32-games.sh'" >> /home/portfolio/.bashrc && \
    echo "alias term-site='cd ~/projects/term-site && /home/portfolio/scripts/term-site.sh'" >> /home/portfolio/.bashrc && \
    echo "alias trade-up-bot='cd ~/projects/trade-up-bot && /home/portfolio/scripts/trade-up-bot.sh'" >> /home/portfolio/.bashrc && \
    echo "alias dotfiles='cd ~/.dotfiles && /home/portfolio/scripts/dotfiles.sh'" >> /home/portfolio/.bashrc && \
    echo "alias home='cd ~ && /home/portfolio/scripts/welcome.sh'" >> /home/portfolio/.bashrc && \
    echo "alias welcome='cd ~ && /home/portfolio/scripts/welcome.sh'" >> /home/portfolio/.bashrc && \
    echo "alias contact='cd ~ && /home/portfolio/scripts/contact.sh'" >> /home/portfolio/.bashrc && \
    echo "alias about='cd ~ && /home/portfolio/scripts/about.sh'" >> /home/portfolio/.bashrc && \
    echo "alias help='/home/portfolio/scripts/help.sh'" >> /home/portfolio/.bashrc && \
    echo "alias resume='cd ~ && /home/portfolio/scripts/resume.sh'" >> /home/portfolio/.bashrc

# Set proper ownership
RUN chown -R portfolio:portfolio /home/portfolio

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
ENV PATH=/home/portfolio/.local/bin:/home/portfolio/scripts:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Default command starts secure shell
CMD ["/home/portfolio/secure-shell.sh"]
