#!/bin/bash
# certbot pre-hook: free port 80 so the standalone authenticator can bind it.
# Runs only when a certificate is actually due for renewal. term-nginx holds
# :80/:443, so without this the standalone renewal can't bind and the cert
# silently lapses (root cause of the Jun 2026 expiry).
docker stop term-nginx 2>/dev/null || true
