#!/bin/sh
set -eu
exec /opt/homebrew/bin/podman exec -i fablecut-hardened-trial node /app/mcp-server.js
