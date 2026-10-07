#!/usr/bin/env bash
# Grab a still from a local camera and push it to the platform.
# Run from cron every few minutes, e.g.:
#   */5 * * * * /opt/cams/push-frame.sh
#
# Required env: SERVER, CAMERA_ID, INGEST_KEY
# Optional:     RTSP_URL (grab a frame with ffmpeg) or SNAPSHOT_URL (camera's own JPEG endpoint)
#               If neither is set, uses libcamera-still (Raspberry Pi camera).
set -euo pipefail
: "${SERVER:?}" "${CAMERA_ID:?}" "${INGEST_KEY:?}"
TMP="$(mktemp --suffix=.jpg)"
trap 'rm -f "$TMP"' EXIT

if [[ -n "${RTSP_URL:-}" ]]; then
  ffmpeg -loglevel error -rtsp_transport tcp -i "$RTSP_URL" -frames:v 1 -q:v 3 -y "$TMP"
elif [[ -n "${SNAPSHOT_URL:-}" ]]; then
  curl -fsS -m 20 -o "$TMP" "$SNAPSHOT_URL"
else
  libcamera-still -n -t 1000 --width 1920 --height 1080 -o "$TMP"
fi

curl -fsS -m 30 -X POST \
  -H "Authorization: Bearer ${INGEST_KEY}" \
  -H "Content-Type: image/jpeg" \
  --data-binary @"$TMP" \
  "${SERVER%/}/api/ingest/${CAMERA_ID}"
echo
