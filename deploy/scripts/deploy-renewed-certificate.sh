#!/usr/bin/env bash

set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  printf 'Run this certificate deploy hook as root.\n' >&2
  exit 77
fi

expected_domain="${WX_UPLOAD_TLS_DOMAIN:-api.rollinwave.store}"
lineage="${RENEWED_LINEAGE:-}"
deploy_root="${WX_UPLOAD_DEPLOY_ROOT:-/opt/wx-private-media-upload}"
environment_file="${WX_UPLOAD_ENV_FILE:-/etc/wx-private-media-upload/production.env}"
certificate_target="${WX_UPLOAD_TLS_CERTIFICATE_FILE:-/etc/wx-private-media-upload/tls/origin.crt}"
private_key_target="${WX_UPLOAD_TLS_PRIVATE_KEY_FILE:-/etc/wx-private-media-upload/tls/origin.key}"
docker_bin="${WX_UPLOAD_DOCKER_BIN:-docker}"
flock_bin="${WX_UPLOAD_FLOCK_BIN:-flock}"
curl_bin="${WX_UPLOAD_CURL_BIN:-curl}"

if [[ -z "$lineage" || ! -r "$lineage/fullchain.pem" || ! -r "$lineage/privkey.pem" ]]; then
  printf 'RENEWED_LINEAGE must contain readable fullchain.pem and privkey.pem files.\n' >&2
  exit 66
fi

if [[ ! -f "$deploy_root/release.env" || ! -f "$environment_file" ]]; then
  printf 'Production release state or environment file is missing.\n' >&2
  exit 66
fi

if ! openssl x509 -in "$lineage/fullchain.pem" -noout -checkhost "$expected_domain" \
  >/dev/null; then
  printf 'Renewed certificate does not cover %s.\n' "$expected_domain" >&2
  exit 65
fi

if ! openssl x509 -in "$lineage/fullchain.pem" -noout -checkend 604800 >/dev/null; then
  printf 'Renewed certificate expires in less than seven days.\n' >&2
  exit 65
fi

certificate_public_key="$(
  openssl x509 -in "$lineage/fullchain.pem" -pubkey -noout |
    openssl pkey -pubin -outform DER 2>/dev/null |
    sha256sum |
    cut -d' ' -f1
)"
private_public_key="$(
  openssl pkey -in "$lineage/privkey.pem" -pubout -outform DER 2>/dev/null |
    sha256sum |
    cut -d' ' -f1
)"

if [[ -z "$certificate_public_key" || "$certificate_public_key" != "$private_public_key" ]]; then
  printf 'Renewed certificate and private key do not match.\n' >&2
  exit 65
fi

lock_file="$deploy_root/.deploy.lock"
touch "$lock_file"
chmod 0600 "$lock_file"
exec 9>"$lock_file"
if ! "$flock_bin" -w 300 9; then
  printf 'Timed out waiting for the production deployment lock.\n' >&2
  exit 75
fi

# shellcheck disable=SC1090
set -a
. "$deploy_root/release.env"
set +a

compose_file="$deploy_root/current/deploy/docker-compose.prod.yml"
if [[ ! -f "$compose_file" ]]; then
  printf 'Current production Compose file is missing.\n' >&2
  exit 66
fi

compose() {
  "$docker_bin" compose \
    --project-name wx-private-media-upload-production \
    --env-file "$environment_file" \
    --file "$compose_file" \
    "$@"
}

tls_directory="$(dirname "$certificate_target")"
if [[ "$tls_directory" != "$(dirname "$private_key_target")" ]]; then
  printf 'Certificate and private key targets must share a directory.\n' >&2
  exit 65
fi
install -d -o root -g wxdeploy -m 0750 "$tls_directory"

backup_directory="$(mktemp -d "$tls_directory/.renewal-backup.XXXXXX")"
certificate_temporary="$(mktemp "$tls_directory/.certificate.XXXXXX")"
private_key_temporary="$(mktemp "$tls_directory/.private-key.XXXXXX")"
rollback_required=0

cleanup() {
  local status=$?
  if [[ $status -ne 0 && $rollback_required -eq 1 ]]; then
    printf 'Certificate deployment failed; restoring the previous certificate.\n' >&2
    install -o root -g wxdeploy -m 0640 \
      "$backup_directory/origin.crt" "$certificate_target" || true
    install -o root -g root -m 0600 \
      "$backup_directory/origin.key" "$private_key_target" || true
    compose up --detach --no-deps --force-recreate nginx >/dev/null 2>&1 || true
  fi
  rm -f "$certificate_temporary" "$private_key_temporary"
  rm -rf "$backup_directory"
  exit "$status"
}
trap cleanup EXIT

install -o root -g wxdeploy -m 0640 "$certificate_target" \
  "$backup_directory/origin.crt"
install -o root -g root -m 0600 "$private_key_target" \
  "$backup_directory/origin.key"

install -o root -g wxdeploy -m 0640 "$lineage/fullchain.pem" "$certificate_temporary"
install -o root -g root -m 0600 "$lineage/privkey.pem" "$private_key_temporary"
mv -f "$certificate_temporary" "$certificate_target"
mv -f "$private_key_temporary" "$private_key_target"
rollback_required=1

compose config --quiet
compose up --detach --no-deps --force-recreate nginx

"$curl_bin" --fail --silent --show-error --noproxy '*' \
  --retry 15 --retry-all-errors --retry-delay 1 \
  --connect-timeout 3 --max-time 60 \
  --resolve "$expected_domain:443:127.0.0.1" \
  "https://$expected_domain/health/live" >/dev/null

rollback_required=0
printf 'Deployed renewed certificate for %s.\n' "$expected_domain"
