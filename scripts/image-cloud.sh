#!/bin/sh
# The layer of the cloud image (munhq/desk#116, #244; docker/Dockerfile.server target `cloud`): the root that Buck2 builds as
# //:cloud-image, and the build stamp that the server reports. The step gives each secret as a file: the list of private names
# (privatenames) and the key of the client (glitchtipdsn) go to the environment of this machine, where the site actions read them
# (they run on the machine of the build), so they are in no action and in no key of the cache.
set -eu
f="${DESK_BUILD_SECRET_PRIVATENAMES_FILE:-}"
if [ -n "$f" ] && [ -s "$f" ]; then
  CHAT_RECALL_PRIVATE_NAMES="$(cat "$f")"
  export CHAT_RECALL_PRIVATE_NAMES
fi
f="${DESK_BUILD_SECRET_GLITCHTIPDSN_FILE:-}"
if [ -n "$f" ] && [ -s "$f" ]; then
  VITE_GLITCHTIP_DSN="$(cat "$f")"
  export VITE_GLITCHTIP_DSN
fi
sh .desk/workflows/buck-node/scripts/image-target.sh //:cloud-image $(sh scripts/mounts-hash.sh)
printf '%s' "${DESK_IMAGE_REVISION:-$(date -u +%Y%m%dT%H%M%SZ)}" > "$DESK_IMAGE_ROOT/app/.build-stamp"
mkdir -p "$DESK_IMAGE_ROOT/data"
