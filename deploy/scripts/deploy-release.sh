#!/usr/bin/env bash

set -Eeuo pipefail

usage() {
  printf 'Usage: %s <ghcr-image> <40-character-commit-sha> <repository-root>\n' "$0" >&2
}

if [[ $# -ne 3 ]]; then
  usage
  exit 64
fi

api_image="$1"
image_tag="$2"
source_root="$3"
postgres_image="${api_image}:postgres-${image_tag}"
nginx_image="${api_image}:nginx-${image_tag}"
deploy_root="${WX_UPLOAD_DEPLOY_ROOT:-/opt/wx-private-media-upload}"
environment_file="${WX_UPLOAD_ENV_FILE:-/etc/wx-private-media-upload/production.env}"
docker_bin="${WX_UPLOAD_DOCKER_BIN:-docker}"

if [[ ! "$api_image" =~ ^ghcr\.io/[a-z0-9]+([._-][a-z0-9]+)*/[a-z0-9]+([._-][a-z0-9]+)*$ ]]; then
  printf 'The API image must be a lowercase GHCR repository path.\n' >&2
  exit 65
fi

if [[ ! "$image_tag" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'The image tag must be the full 40-character commit SHA.\n' >&2
  exit 65
fi

if [[ "$deploy_root" != /* || "$deploy_root" == '/' ]]; then
  printf 'WX_UPLOAD_DEPLOY_ROOT must be a safe absolute path.\n' >&2
  exit 65
fi

if [[ ! -d "$source_root/deploy" ]]; then
  printf 'Repository root does not contain the deploy directory.\n' >&2
  exit 66
fi

if [[ ! -f "$environment_file" ]]; then
  printf 'Production environment file is missing: %s\n' "$environment_file" >&2
  exit 66
fi

source_root="$(cd "$source_root" && pwd -P)"
release_root="$deploy_root/releases"
release_directory="$release_root/$image_tag"
lock_directory="$deploy_root/.deploy.lock"
staging_directory=''

install -d -m 0750 "$deploy_root" "$release_root" "$deploy_root/bin"

if ! mkdir "$lock_directory" 2>/dev/null; then
  printf 'Another production deployment is already running.\n' >&2
  exit 75
fi

cleanup() {
  if [[ -n "$staging_directory" && -d "$staging_directory" ]]; then
    rm -rf "$staging_directory"
  fi
  rmdir "$lock_directory" 2>/dev/null || true
}
trap cleanup EXIT

if [[ ! -d "$release_directory" ]]; then
  staging_directory="$(mktemp -d "$release_root/.staging-$image_tag.XXXXXX")"
  install -d -m 0750 \
    "$staging_directory/deploy/nginx" \
    "$staging_directory/deploy/postgres" \
    "$staging_directory/deploy/scripts"
  install -m 0640 \
    "$source_root/deploy/docker-compose.prod.yml" \
    "$staging_directory/deploy/docker-compose.prod.yml"
  install -m 0640 \
    "$source_root/deploy/nginx/default.conf" \
    "$staging_directory/deploy/nginx/default.conf"
  install -m 0640 \
    "$source_root/deploy/postgres/init-roles.sql" \
    "$staging_directory/deploy/postgres/init-roles.sql"
  install -m 0750 \
    "$source_root/deploy/scripts/deploy-release.sh" \
    "$staging_directory/deploy/scripts/deploy-release.sh"

  API_IMAGE="$api_image" IMAGE_TAG="$image_tag" \
    POSTGRES_IMAGE="$postgres_image" NGINX_IMAGE="$nginx_image" \
    "$docker_bin" compose \
    --project-name wx-private-media-upload-production \
    --env-file "$environment_file" \
    --file "$staging_directory/deploy/docker-compose.prod.yml" \
    config --quiet

  mv "$staging_directory" "$release_directory"
  staging_directory=''
fi

compose() {
  API_IMAGE="$api_image" IMAGE_TAG="$image_tag" \
    POSTGRES_IMAGE="$postgres_image" NGINX_IMAGE="$nginx_image" \
    "$docker_bin" compose \
    --project-name wx-private-media-upload-production \
    --env-file "$environment_file" \
    --file "$release_directory/deploy/docker-compose.prod.yml" \
    "$@"
}

compose config --quiet
compose pull postgres migrate api nginx
compose up --detach --wait --wait-timeout 240

install -m 0750 \
  "$release_directory/deploy/scripts/deploy-release.sh" \
  "$deploy_root/bin/deploy-release.sh"

state_file="$deploy_root/release.env"
state_temporary="$deploy_root/.release.env.$image_tag"
printf 'API_IMAGE=%s\nIMAGE_TAG=%s\nPOSTGRES_IMAGE=%s\nNGINX_IMAGE=%s\nRELEASE_DIRECTORY=%s\n' \
  "$api_image" "$image_tag" "$postgres_image" "$nginx_image" "$release_directory" \
  > "$state_temporary"
chmod 0600 "$state_temporary"
mv "$state_temporary" "$state_file"
ln -sfn "$release_directory" "$deploy_root/current"

printf 'Deployed %s:%s\n' "$api_image" "$image_tag"
