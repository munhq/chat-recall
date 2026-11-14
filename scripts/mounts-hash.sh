#!/bin/sh
# The content hash of the two folders that desk mounts into the tree (`checkouts` of .desk/config.json): the private site
# (site-src/) and the checks of the web (web-standards/bin/). Each has a BUCK file of its own, so a Buck2 rule of this repository
# cannot name its files, and the site action reads them from the project tree. This script prints the two options that put
# the hashes into the key of that action: a change of a file of either folder is a new action, and no change is a hit.
set -eu
hash() {
  # shellcheck disable=SC2038 # the names have no space
  (cd "$1" && find . -type f -not -path './node_modules/*' -not -path '*/node_modules/*' -not -path './.git/*' | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -c1-64)
}
printf -- '-c desk.site_hash=%s -c desk.ws_hash=%s\n' "$(hash site-src)" "$(hash web-standards/bin)"
