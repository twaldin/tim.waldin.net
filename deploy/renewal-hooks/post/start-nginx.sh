#!/bin/bash
# certbot post-hook: bring nginx back up after a renewal attempt and reload it
# so it picks up the new fullchain.pem/privkey.pem. Runs after every renewal
# attempt (pair of the pre-hook stop). Idempotent: start is a no-op if running.
docker start term-nginx 2>/dev/null || true
docker exec term-nginx nginx -s reload 2>/dev/null || true
