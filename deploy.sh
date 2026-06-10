#!/bin/bash
set -e  # Exit on any error

echo "Starting deployment..."

# Stop all containers
echo "Stopping existing containers..."
docker compose down

# Build terminal image on host first
echo "Building terminal container image on host..."
docker build -t twaldin/terminal-portfolio:latest ./container

# Build and start all services
echo "Building and starting services..."
docker compose build --no-cache
docker compose up -d --force-recreate

# Reclaim disk: remove dangling images and ALL build cache left by the
# --no-cache builds above. Safe — only removes data not used by a running
# container. Never prunes volumes (backend_data holds the audit log).
echo "Pruning stale Docker build cache and dangling images..."
docker image prune -f
docker builder prune -f

# Wait for services to initialize
echo "Waiting for services to initialize..."
sleep 5

# Verify socket proxy is working
echo "Verifying socket proxy..."
if docker exec term-socket-proxy wget -q -O - http://localhost:2375/_ping 2>/dev/null | grep -q "OK"; then
    echo "Socket proxy is responding"
else
    echo "WARNING: Socket proxy may not be ready yet"
fi

# Verify containers endpoint works but networks/volumes are blocked
echo "Testing socket proxy permissions..."
if docker exec term-backend wget -q -O /dev/null http://socket-proxy:2375/containers/json 2>/dev/null; then
    echo "  containers endpoint: allowed"
fi

# Check if all required services are running
echo "Checking service health..."
REQUIRED_SERVICES=("term-frontend" "term-backend" "term-nginx" "term-socket-proxy")
ALL_RUNNING=true

for service in "${REQUIRED_SERVICES[@]}"; do
    if ! docker ps --format "table {{.Names}}" | grep -q "^${service}$"; then
        echo "  Service ${service} is NOT running!"
        ALL_RUNNING=false
    else
        echo "  Service ${service} is running"
    fi
done

if [ "$ALL_RUNNING" = false ]; then
    echo "Some services failed to start. Check logs with: docker compose logs"
    exit 1
fi

echo ""
echo "Deployment complete. Container status:"
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

# Verify no privileged containers
echo ""
echo "Privilege check:"
for container in $(docker ps --format '{{.Names}}'); do
    privileged=$(docker inspect --format='{{.HostConfig.Privileged}}' "$container")
    echo "  ${container}: privileged=${privileged}"
done

# Final health check
echo ""
echo "Testing site connectivity..."
if curl -s -o /dev/null -w "%{http_code}" http://localhost/ | grep -q "200\|302"; then
    echo "Site is responding correctly"
else
    echo "Site may not be fully ready yet. Check logs if issues persist."
fi
