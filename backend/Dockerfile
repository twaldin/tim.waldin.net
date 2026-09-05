# Backend with Docker CLI only (no Docker daemon)

FROM node:24-alpine

# Install Docker CLI only
RUN apk add --no-cache docker-cli

WORKDIR /app

# Copy package files from backend directory
COPY backend/package*.json ./

# Install dependencies
RUN npm install

# Copy source code from backend directory. The build context is the repository
# root (docker compose: `context: .`), so Dockerfile.dockerignore beside this
# file, not backend/.dockerignore, decides what stays out (tests, node_modules).
COPY backend/ .

# Expose port
EXPOSE 3001

# Simple start command
CMD ["npm", "start"]
