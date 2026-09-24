# Backend with Docker CLI only (no Docker daemon)

FROM node:24-alpine

# Install Docker CLI only
RUN apk add --no-cache docker-cli

WORKDIR /app

# Copy package files from backend directory
COPY backend/package*.json ./

# Install exactly the locked production dependency graph
RUN npm ci --omit=dev

# Copy source code from backend directory. The build context is the repository
# root (docker compose: `context: .`), so Dockerfile.dockerignore beside this
# file, not backend/.dockerignore, decides what stays out (tests, node_modules).
COPY backend/ .

# Expose port
EXPOSE 3001

# Simple start command
# node directly: the rootfs is read-only (npm writes its logs under ~/.npm) and
# node receives SIGTERM for graceful shutdown without npm in between.
CMD ["node", "server.js"]
