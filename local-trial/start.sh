#!/bin/sh
set -eu
umask 077
trial_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(dirname "$trial_dir")
mkdir -p "$trial_dir/data/inbox" "$trial_dir/.host"
if [ ! -f "$trial_dir/private.env" ]; then
  printf 'FABLECUT_TOKEN=%s\n' "$(openssl rand -hex 32)" > "$trial_dir/private.env"
fi
chmod 600 "$trial_dir/private.env"
podman network exists fablecut-isolated || podman network create --internal fablecut-isolated
podman build -q -t localhost/fablecut-hardened:trial -f "$trial_dir/Containerfile" "$repo_dir"
if podman container exists fablecut-hardened-trial; then
  wanted=$(podman image inspect localhost/fablecut-hardened:trial --format '{{.Id}}')
  actual=$(podman inspect fablecut-hardened-trial --format '{{.Image}}')
  version=$(podman inspect fablecut-hardened-trial --format '{{index .Config.Labels "trial.version"}}')
  if [ "$wanted" != "$actual" ] || [ "$version" != "2" ]; then
    podman rm -f fablecut-hardened-trial >/dev/null
  fi
fi
if podman container exists fablecut-hardened-trial; then
  podman start fablecut-hardened-trial >/dev/null
else
  podman run -d --name fablecut-hardened-trial --network fablecut-isolated \
    --label trial.version=2 --read-only --cap-drop=ALL --security-opt=no-new-privileges \
    --pids-limit=128 --memory=2g --cpus=2 --userns=keep-id --user=1000:1000 \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=512m \
    -v "$trial_dir/data:/data:rw" --env-file "$trial_dir/private.env" localhost/fablecut-hardened:trial >/dev/null
fi
# Tunnel through the local VM; the container has no published ports or default route.
vm_port=$(podman machine inspect --format '{{.SSHConfig.Port}}')
vm_key=$(podman machine inspect --format '{{.SSHConfig.IdentityPath}}')
vm_user=$(podman machine inspect --format '{{.SSHConfig.RemoteUsername}}')
container_ip=$(podman inspect fablecut-hardened-trial --format '{{(index .NetworkSettings.Networks "fablecut-isolated").IPAddress}}')
vm_host_key=$(podman machine ssh cat /etc/ssh/ssh_host_ed25519_key.pub)
printf '[127.0.0.1]:%s %s\n' "$vm_port" "$vm_host_key" > "$trial_dir/.host/known_hosts"
if [ -S "$trial_dir/.host/tunnel.sock" ]; then
  ssh -F /dev/null -S "$trial_dir/.host/tunnel.sock" -O exit "$vm_user@127.0.0.1" 2>/dev/null || true
fi
ssh -F /dev/null -fNT -M -S "$trial_dir/.host/tunnel.sock" \
  -i "$vm_key" -p "$vm_port" -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes \
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$trial_dir/.host/known_hosts" \
  -o ExitOnForwardFailure=yes -L "127.0.0.1:7787:$container_ip:7777" "$vm_user@127.0.0.1"
printf 'Editor: http://127.0.0.1:7787\nLogin user: fablecut\nPassword: FABLECUT_TOKEN in %s/private.env\n' "$trial_dir"
