#!/bin/sh
# The layer of the self-host image (munhq/desk#116, docker/Dockerfile.server stage `runtime`): the root that Buck2 builds as
# //:selfhost-image, and the build stamp that the server reports. The stamp is the revision of the landing, so it is written here and
# not in a cached action. The base image gives node and curl.
set -eu
sh .desk/workflows/buck-node/scripts/image-target.sh //:selfhost-image
printf '%s' "${DESK_IMAGE_REVISION:-$(date -u +%Y%m%dT%H%M%SZ)}" > "$DESK_IMAGE_ROOT/app/.build-stamp"
mkdir -p "$DESK_IMAGE_ROOT/data"
