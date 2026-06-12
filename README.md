# Terminal Portfolio

My portfolio website that looks like a terminal. Users get an xterm.js terminal in their browser that connects to isolated Docker containers where they can run commands, explore my projects, view my resume, etc.

Live at [tim.waldin.net](https://tim.waldin.net)

## Architecture

```
Browser (xterm.js) → Nginx (reverse proxy, SSL, rate limiting)
                        ├── Next.js frontend (port 3000)
                        └── Node.js backend (port 3001)
                              ↕ Socket.IO
                              ↕ Docker Socket Proxy (port 2375)
                              └── Isolated Ubuntu container per user
```

## Tech Stack

- **Frontend**: Next.js 15, React 19, xterm.js 5.5, Socket.IO client
- **Backend**: Node.js 18, Express, Socket.IO, dockerode
- **Container**: Ubuntu 24.04, zsh, Oh My Posh, Nerd Fonts, figlet
- **Infrastructure**: Docker Compose, Nginx, Let's Encrypt SSL
- **Theme**: Gruvbox Dark with JetBrainsMono Nerd Font

## Project Structure

```
term-site/
├── frontend/              # Next.js app with xterm.js terminal
│   ├── src/
│   │   ├── components/    # Terminal.tsx (dynamic font sizing, OSC 8 links)
│   │   ├── config/        # Gruvbox Dark theme
│   │   └── lib/           # Socket.IO client manager
│   └── public/            # Static assets (fonts, resume.pdf)
├── backend/               # Node.js server that manages Docker containers
│   ├── server.js          # Socket.IO server with rate limiting
│   └── session.js         # Container lifecycle, auto-welcome, cleanup
├── container/             # Ubuntu Docker container with portfolio content
│   ├── Dockerfile         # Container setup (repos, dotfiles, Oh My Posh)
│   ├── scripts/           # Portfolio navigation scripts
│   │   ├── welcome.sh     # Home page with ASCII art
│   │   ├── projects.sh    # Project listing
│   │   ├── stm32-games.sh # Project pages with git activity
│   │   ├── term-site.sh
│   │   ├── trade-up-bot.sh
│   │   ├── dotfiles.sh
│   │   ├── resume.sh      # Resume with clickable link
│   │   ├── about.sh
│   │   ├── contact.sh     # OSC 8 hyperlinks for email/socials
│   │   ├── help.sh
│   │   └── shared-functions.sh  # Colors, typewriter, ASCII art, boxes
├── docker-compose.yml     # Service orchestration
├── nginx.conf             # Reverse proxy, SSL, rate limiting
└── deploy.sh              # Automated deployment script
```

## Security

Each user gets an isolated Docker container with:
- 512MB RAM limit, 0.5 CPU limit, 100 process limit
- No network access (`NetworkMode: none`)
- Non-root user with all capabilities dropped
- `no-new-privileges` security option
- 15-minute inactivity timeout with auto-cleanup
- Docker Socket Proxy restricts API access (no networks/volumes/build)

Users can run destructive commands like `rm -rf /` or fork bombs - they only affect their own container, not the host.

## Terminal Commands

Custom portfolio navigation:
- `welcome` / `home` - Home page with ASCII art
- `projects` - Browse all projects
- `about` - About me
- `contact` - Email and social links
- `resume` - View my resume
- `help` - Show available commands
- `stm32-games`, `term-site`, `trade-up-bot`, `dotfiles` - Jump to project repos

Plus standard Linux tools: `ls`, `cd`, `cat`, `nvim`, `git`, `grep`, `rg`, `fzf`, `tree`, `htop`, `bat`, etc.

## Features

- Dynamic font sizing to fit ASCII art on any screen width
- Gruvbox Dark color scheme across terminal, vim, and bat
- Clickable hyperlinks via OSC 8 protocol
- Animated typewriter text and ASCII art (figlet with DOS_Rebel font)
- Auto-typed `welcome` command on connect
- Pre-cloned git repos with live git activity display
- Oh My Posh shell prompt with Nerd Font icons
- Copy/paste support, tab completion
