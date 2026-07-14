#!/bin/sh
set -eu

mc alias set local "${MINIO_ENDPOINT}" "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}"
mc mb --ignore-existing "local/${MINIO_BUCKET}"
mc anonymous set none "local/${MINIO_BUCKET}"
