#!/bin/bash
set -e  # Exit on any error

echo "Starting deployment..."

# Build everything BEFORE stopping the stack — the old services keep serving
# while images build, so downtime is the container swap (seconds), not the
# multi-minute --no-cache build. Crawlers (X/Google link previews) used to
# catch the dark window and cache imageless/failed cards.
echo "Building terminal container image on host..."
# STARS_REFRESH busts only the final .stars layer so every deploy re-fetches
# the GitHub star counts shown by welcome.sh (runtime containers have no
# network, so build time is the only chance).
docker build --build-arg STARS_REFRESH="$(date +%s)" -t twaldin/terminal-portfolio:latest ./container

echo "Building service images..."
docker compose build --no-cache

# Swap: stop old stack, start freshly built images
echo "Restarting services on new images..."
docker compose down
docker compose up -d --force-recreate

# Reclaim disk: remove dangling images and ALL build cache left by the
# --no-cache builds above. Safe — only removes data not used by a running
# container. Never prunes volumes (backend_data holds the audit log).
echo "Pruning stale Docker build cache and dangling images..."
docker image prune -f
docker builder prune -f

# Install certbot renewal hooks so the certbot.timer can renew the TLS cert
# while nginx is running. The renewal uses the standalone authenticator, which
# needs port 80 — held by term-nginx. These hooks stop nginx before renewal and
# restart it after, so auto-renewal actually succeeds (without them the cert
# silently lapses; see the Jun 2026 expiry incident).
echo "Installing certbot renewal hooks..."
if [ -d /etc/letsencrypt/renewal-hooks ]; then
    install -m 0755 deploy/renewal-hooks/pre/stop-nginx.sh   /etc/letsencrypt/renewal-hooks/pre/stop-nginx.sh
    install -m 0755 deploy/renewal-hooks/post/start-nginx.sh /etc/letsencrypt/renewal-hooks/post/start-nginx.sh
    echo "  renewal hooks installed"
else
    echo "  WARNING: /etc/letsencrypt/renewal-hooks not found — skipping (certbot not installed?)"
fi

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

# Verify the proxy-validator gate using dockerode — the SAME client the backend
# uses — so a protocol/TLS mismatch (e.g. auto-TLS on :2376) is caught here,
# not only after a visitor fails to lease a session.
echo "Testing proxy-validator gate (via dockerode)..."
VAL_OUT=$(docker exec term-backend node -e '
const Docker = require("dockerode");
const d = new Docker({ protocol: "http", host: "proxy-validator", port: 2376 });
(async () => {
  try { await d.ping(); console.log("validator-ping:ok"); }
  catch (e) { console.log("validator-ping-err:" + e.message); }
  try { await d.listContainers(); console.log("validator-read:ok"); }
  catch (e) { console.log("validator-read-err:" + e.message); }
  try {
    // A privileged create MUST be rejected by the validator (403), never forwarded.
    await d.createContainer({ Image: "evil:latest", HostConfig: { Privileged: true } });
    console.log("validator-reject:NOT-REJECTED");
  } catch (e) { console.log("validator-reject:" + (e.statusCode || e.reason || e.message)); }
})();
')
if echo "$VAL_OUT" | grep -q "validator-ping:ok" && echo "$VAL_OUT" | grep -q "validator-read:ok"; then
    echo "  backend reaches Docker through the validator (ping+read): OK"
else
    echo "  WARNING: backend cannot reach Docker via proxy-validator! $VAL_OUT"
fi
if echo "$VAL_OUT" | grep -q "validator-reject:403"; then
    echo "  validator REJECTS privileged create: enforced"
else
    echo "  WARNING: validator did NOT reject a privileged create! $VAL_OUT"
fi

# Check if all required services are running
echo "Checking service health..."
REQUIRED_SERVICES=("term-frontend" "term-backend" "term-nginx" "term-socket-proxy" "term-proxy-validator")
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
