#!/bin/sh
# Install the dependencies of a check with `npm ci`, or restore them from the archive that an earlier run with the same
# lock files made on this runner. The archive holds node_modules and the node_modules folders of the packages.
#   sh scripts/ci-install.sh [npm ci arguments]
# The key is the hash of the lock files, the package files, .npmrc, the arguments and the version of node, so a change
# of a dependency installs again. A missing or broken archive falls back to `npm ci`, so a check never reads stale files.
set -eu

store="${npm_config_cache:-${HOME:-/tmp}/.npm}/node-modules-by-lock"
key=$(
  {
    cat package-lock.json package.json .npmrc 2>/dev/null
    for f in packages/*/package.json; do cat "$f"; done
    echo "$*"
    node -p 'process.version + process.arch + process.platform'
  } | sha256sum | cut -c1-32
)
archive="$store/$key.tar"

if [ -f "$archive" ] && tar -xf "$archive" 2>/dev/null; then
  echo "ci-install: restored the dependencies from $key"
  exit 0
fi

rm -rf node_modules packages/*/node_modules
npm ci --no-audit --no-fund "$@"

mkdir -p "$store"
tmp="$archive.$$"
dirs=$(ls -d node_modules packages/*/node_modules 2>/dev/null | tr '\n' ' ')
# shellcheck disable=SC2086
if tar -cf "$tmp" $dirs 2>/dev/null; then
  mv "$tmp" "$archive"
else
  rm -f "$tmp"
fi
# Keep the store small: the five newest archives stay.
ls -t "$store"/*.tar 2>/dev/null | tail -n +6 | while read -r old; do rm -f "$old"; done
