#!/bin/sh
set -eu
trial_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -S "$trial_dir/.host/tunnel.sock" ]; then
  ssh -F /dev/null -S "$trial_dir/.host/tunnel.sock" -O exit localhost 2>/dev/null || true
fi
exec podman stop fablecut-hardened-trial
