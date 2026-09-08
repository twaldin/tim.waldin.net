#!/bin/bash
set -e

# Keep local and deployment image builds on the same argument path.
cd "$(dirname "$0")/.."
BUILD_SECRET_ARGS=()
GITHUB_TOKEN_FILE="${GITHUB_TOKEN_FILE:-/home/deploy/.github_token}"
if [[ -s "$GITHUB_TOKEN_FILE" ]]; then
    BUILD_SECRET_ARGS+=(--secret "id=github_token,src=$GITHUB_TOKEN_FILE")
fi

echo "Building terminal portfolio container..."
docker build "${BUILD_SECRET_ARGS[@]}" -t twaldin/terminal-portfolio:latest "$@" ./container
echo "Container built successfully!"
echo "To test: docker run -it --rm twaldin/terminal-portfolio:latest"
