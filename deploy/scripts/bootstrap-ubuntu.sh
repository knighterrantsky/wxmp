#!/usr/bin/env bash

set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  printf 'Run this bootstrap as root.\n' >&2
  exit 77
fi

if [[ ! -r /etc/os-release ]]; then
  printf 'Cannot identify the operating system.\n' >&2
  exit 69
fi

# shellcheck disable=SC1091
. /etc/os-release
if [[ "${ID:-}" != 'ubuntu' ]]; then
  printf 'This bootstrap supports Ubuntu only.\n' >&2
  exit 69
fi

swap_size_gb="${SWAP_SIZE_GB:-2}"
if [[ ! "$swap_size_gb" =~ ^[1-9][0-9]*$ ]]; then
  printf 'SWAP_SIZE_GB must be a positive integer.\n' >&2
  exit 64
fi

export DEBIAN_FRONTEND=noninteractive
# Remove a source left by an interrupted older bootstrap revision. Ubuntu 24.04
# supplies current Docker, Buildx, and Compose packages through its own mirror.
if [[ -f /etc/apt/sources.list.d/docker.list ]] && \
  grep -qF 'download.docker.com' /etc/apt/sources.list.d/docker.list; then
  rm -f /etc/apt/sources.list.d/docker.list
fi

apt-get update
apt-get install --yes \
  ca-certificates \
  docker.io \
  docker-buildx \
  docker-compose-v2

install -d -m 0755 /etc/docker
if [[ ! -e /etc/docker/daemon.json ]]; then
  printf '%s\n' \
    '{' \
    '  "log-driver": "json-file",' \
    '  "log-opts": {' \
    '    "max-size": "10m",' \
    '    "max-file": "3"' \
    '  }' \
    '}' > /etc/docker/daemon.json
fi

systemctl enable --now docker
systemctl restart docker

if ! id wxdeploy >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash wxdeploy
fi
usermod --append --groups docker wxdeploy

install -d -o wxdeploy -g wxdeploy -m 0750 \
  /opt/wx-private-media-upload \
  /opt/wx-private-media-upload/releases \
  /opt/wx-private-media-upload/bin
install -d -o root -g wxdeploy -m 0750 /etc/wx-private-media-upload

if [[ ! -e /etc/wx-private-media-upload/production.env ]]; then
  install -o root -g wxdeploy -m 0640 /dev/null \
    /etc/wx-private-media-upload/production.env
fi

if ! swapon --show=NAME --noheadings | grep -qx '/swapfile'; then
  if [[ ! -e /swapfile ]]; then
    fallocate --length "${swap_size_gb}G" /swapfile
  fi
  chmod 0600 /swapfile
  mkswap /swapfile
  swapon /swapfile
fi

if ! grep -qF '/swapfile none swap sw 0 0' /etc/fstab; then
  printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
fi

docker version >/dev/null
docker compose version >/dev/null

printf '%s\n' \
  'Server bootstrap completed.' \
  'Next: fill /etc/wx-private-media-upload/production.env as root.' \
  'Then register a GitHub Actions runner under the wxdeploy account.'
