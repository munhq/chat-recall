# The tests of chat-recall as Buck2 targets (munhq/desk#244): each shard of vitest is an action on declared inputs, so
# NativeLink serves the result of a shard whose inputs did not change, and the shards run in parallel on the workers. The
# rules are the workflow buck-node, mounted by `checkouts` of .desk/config.json. The check is //:check.
load("@desk_node//:defs.bzl", "action", "node_action", "node_modules", "vitest_shards")

WORKSPACES = ["packages/engine", "packages/cli", "packages/server"]

# The three workspaces from the lock file only. The private @munhq packages need the registry token, so the install runs
# on the machine of the build with NODE_AUTH_TOKEN of its environment: the token is no part of any action or key.
node_modules(
    name = "node_modules",
    srcs = ["package.json", "package-lock.json", ".npmrc"] + [w + "/package.json" for w in WORKSPACES],
    workspaces = WORKSPACES,
    private_packages = True,
    install = "npm ci --no-audit --no-fund --loglevel=error",
    toolchain = {"DESK_TOOLCHAIN": read_root_config("desk", "toolchain", "")},
)

SOURCES = glob(["**", "**/.*", "**/.*/**"], exclude = ["**/.git/**", "**/.desk-work/**", ".desk/**", "node_modules/**", "packages/*/node_modules/**", "packages/server/client/node_modules/**", "buck-out/**", ".buckconfig*", "BUCK", "coverage/**"])

# vitest of each package in two shards, as the checks `packages/<name>:test-<n>of2` ran. The tests of the cli read the public
# plugin files, which `build:public` writes first.
CHECKS = vitest_shards(
    folders = ["packages/engine", "packages/cli", "packages/server"],
    srcs = SOURCES,
    before = {"packages/cli": "npm run build:public && "},
)

# node --check of every script of the packages, as the checks `packages/<name>:syntax` ran.
node_action(
    name = "syntax",
    srcs = SOURCES,
    cmd = "find packages -name node_modules -prune -o \\( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \\) -print0 | xargs -0 -r -n1 node --check",
)
CHECKS.append(":syntax")

# ── The self-host image (docker/Dockerfile.server, stage `runtime`) ───────────────────────────────────────────────────────────
# Each stage of the Dockerfile is a cached target. The root of the image layer is //:selfhost-image: /app with the production
# packages, the built engine, server and client, the migrations and the CLI package. The build stamp is written by the image
# script, because it changes with every landing.
TSCONFIGS = ["tsconfig.base.json", "tsconfig.json"]
ENGINE = glob(["packages/engine/**", "packages/engine/.*", "packages/engine/**/.*"], exclude = ["**/*.tsbuildinfo", "packages/engine/node_modules/**", "packages/engine/dist/**"])
SERVER = glob(["packages/server/**", "packages/server/.*", "packages/server/**/.*"], exclude = ["**/*.tsbuildinfo", "packages/server/node_modules/**", "packages/server/dist/**", "packages/server/client/**"])
CLI = glob(["packages/cli/**", "packages/cli/.*", "packages/cli/**/.*"], exclude = ["**/*.tsbuildinfo", "packages/cli/node_modules/**", "packages/cli/dist/**"])
CLIENT = glob(["packages/server/client/**", "packages/server/client/.*", "packages/server/client/**/.*"], exclude = ["**/*.tsbuildinfo", "packages/server/client/node_modules/**", "packages/server/client/dist/**"])

# The packages that the server runs with: the install without the dev dependencies.
node_modules(
    name = "prod_modules",
    srcs = ["package.json", "package-lock.json", ".npmrc"] + [w + "/package.json" for w in WORKSPACES],
    workspaces = WORKSPACES,
    private_packages = True,
    install = "npm ci --no-audit --no-fund --loglevel=error && npm prune --omit=dev --no-audit --no-fund --loglevel=error",
    toolchain = {"DESK_TOOLCHAIN": read_root_config("desk", "toolchain", "")},
)

# The packages of the web client, which has an install of its own.
node_modules(
    name = "client_modules",
    srcs = ["packages/server/client/package.json", "packages/server/client/package-lock.json"],
    root = "packages/server/client",
    private_packages = True,
    toolchain = {"DESK_TOOLCHAIN": read_root_config("desk", "toolchain", "")},
)

# The shared engine, compiled: the client imports its secret classifier, and the server and the CLI run on it.
node_action(
    name = "engine_dist",
    srcs = ENGINE + TSCONFIGS + ["package.json"],
    cmd = "npx tsc -b packages/engine",
    directory = True,
    result = "mkdir -p $O && cp -R packages/engine/dist/. $O/",
    priority = 4,
)

# The web client: Vite with the engine in its node_modules, as the stage `client` did. VITE_CLOUD is empty for the self-host image.
node_action(
    name = "client_dist",
    srcs = CLIENT + ["packages/engine/package.json"],
    deps = {"engine": ":engine_dist"},
    node_modules_target = ":client_modules",
    root = "packages/server/client",
    copy_modules = True,
    directory = True,
    cmd = "mkdir -p node_modules/@chat-recall/engine && cp $B/packages/engine/package.json node_modules/@chat-recall/engine/package.json && cp -R $D_engine node_modules/@chat-recall/engine/dist && npm run build",
    result = "mkdir -p $O && cp -R dist/. $O/",
    priority = 4,
)

# The server, compiled (tsc -b builds the engine it refers to).
node_action(
    name = "server_dist",
    srcs = ENGINE + SERVER + TSCONFIGS + ["package.json"],
    cmd = "npx tsc -b packages/server",
    directory = True,
    result = "mkdir -p $O/server $O/engine && cp -R packages/server/dist/. $O/server/ && cp -R packages/engine/dist/. $O/engine/",
    priority = 4,
)

# The CLI package that the server serves for download (install/chat-recall.tgz) and its version.
node_action(
    name = "cli_pack",
    srcs = ENGINE + CLI + TSCONFIGS + ["package.json", "README.md"],
    cmd = "npx tsc -b packages/engine && npm run build --workspace=chat-recall && mkdir -p $B/pack && npm pack --workspace=chat-recall --pack-destination $B/pack",
    directory = True,
    result = "mkdir -p $O/install && mv $B/pack/chat-recall-*.tgz $O/install/chat-recall.tgz && node -p \"require('./packages/cli/package.json').version\" > $O/install/cli-version.txt",
    priority = 4,
)

# The root of the image layer.
action(
    name = "selfhost-image",
    srcs = ["package.json", "package-lock.json", "packages/engine/package.json", "packages/server/package.json", "packages/server/cloud/migrate.mjs"] + glob(["packages/server/cloud/migrations/**", "packages/server/scripts/import-*-users.mjs"]),
    deps = {"prod": ":prod_modules", "engine": ":engine_dist", "server": ":server_dist", "client": ":client_dist", "cli": ":cli_pack"},
    out = "selfhost-image",
    directory = True,
    cmd = "O=`realpath -m $OUT` && P=`realpath $DEP_prod` && E=`realpath $DEP_engine` && S=`realpath $DEP_server` && C=`realpath $DEP_client` && L=`realpath $DEP_cli` && cd $SRCDIR && A=$O/app && mkdir -p $A/packages/engine $A/packages/server/scripts $A/migrate $A/install && cp package.json package-lock.json $A/ && cp packages/engine/package.json $A/packages/engine/ && cp packages/server/package.json $A/packages/server/ && cp -R $P/node_modules $A/node_modules && cp -R $P/packages/server/node_modules $A/packages/server/node_modules && cp -R $E $A/packages/engine/dist && cp -R $S/server $A/packages/server/dist && cp -R $C $A/client && cp packages/server/cloud/migrate.mjs $A/migrate/migrate.mjs && cp -R packages/server/cloud/migrations $A/migrate/migrations && cp packages/server/scripts/import-*-users.mjs $A/packages/server/scripts/ && cp -R $L/install/. $A/install/",
)

# ── The cloud image (docker/Dockerfile.server, target `cloud`) ─────────────────────────────────────────────────────────────────
# The self-host image, with the web client built for the cloud and the site and the docs of chatrecall.dev on top (the stage `site`).
# The private repository munhq/chat-recall-site is mounted at site-src/ and munhq/web-standards at web-standards/ (`checkouts` of
# .desk/config.json). Each has a BUCK file of its own, so each is a package of its own and a rule of this package cannot name its
# files: the site action reads the two folders from the project tree, and scripts/mounts-hash.sh gives their content hash as
# `-c desk.site_hash` and `-c desk.ws_hash`, which are in the key of the action. The site actions run on the machine of the build, which has the secrets of the run in its environment: the list
# of the private names (CHAT_RECALL_PRIVATE_NAMES, which only makes the generator refuse a page, so the output does not depend on its
# value) and the key of the client (VITE_GLITCHTIP_DSN). They are no part of an action or of its key. Chromium is in the base of the runner.
TOOLCHAIN = {"DESK_TOOLCHAIN": read_root_config("desk", "toolchain", "")}

# The MCP tool and CLI references of the docs come from the built engine and CLI.
node_action(
    name = "reference_json",
    srcs = ENGINE + CLI + TSCONFIGS + ["package.json", "scripts/dump-reference.mjs"],
    cmd = "npx tsc -b packages/engine && npm run build --workspace=chat-recall && mkdir -p $B/out && node scripts/dump-reference.mjs $B/out/reference.json",
    directory = True,
    result = "mkdir -p $O && cp $B/out/reference.json $O/reference.json",
    priority = 4,
)

# The web client built for the cloud: VITE_CLOUD is on, and the key of the client comes from the environment of the machine.
node_action(
    name = "client_dist_cloud",
    srcs = CLIENT + ["packages/engine/package.json"],
    deps = {"engine": ":engine_dist"},
    node_modules_target = ":client_modules",
    root = "packages/server/client",
    copy_modules = True,
    directory = True,
    local_only = True,
    env = {"VITE_CLOUD": "1"},
    cmd = "mkdir -p node_modules/@chat-recall/engine && cp $B/packages/engine/package.json node_modules/@chat-recall/engine/package.json && cp -R $D_engine node_modules/@chat-recall/engine/dist && npm run build",
    result = "mkdir -p $O && cp -R dist/. $O/",
    priority = 4,
)

PRODUCT_FILES = [
    "README.md",
    "packages/server/client/src/index.css",
    "packages/server/client/src/fonts.css",
    "packages/cli/package.json",
    "packages/cli/src/mcp.ts",
    "packages/engine/src/mcp/tools.ts",
    "packages/engine/src/core/live-session-scan.ts",
    "packages/server/src/util/entitlements.ts",
    "packages/server/src/util/billing.ts",
    "packages/server/src/routes/licence.ts",
]

# The site and the docs: the generator, the gates of the site workflow (SEO audit, pricing parity, external links, the social cards
# against their template, a docs build that stops on a broken link), and the overlay that goes on the client.
action(
    name = "site_overlay",
    srcs = glob(["docs/**", "packages/server/client/public/fonts/**"]) + PRODUCT_FILES,
    deps = {"reference": ":reference_json"},
    out = "site_overlay",
    directory = True,
    local_only = True,
    env = dict(
        TOOLCHAIN,
        OPENAI_APPS_CHALLENGE = "hC6GpWiSrnfYr34L0vC8otCzbMzCJXoX7ZgXHlEbbbw",
        SITE_HASH = read_root_config("desk", "site_hash", ""),
        WS_HASH = read_root_config("desk", "ws_hash", ""),
    ),
    priority = 4,
    cmd = "P=$PWD && O=`realpath -m $OUT` && R=`realpath $DEP_reference` && B=`mktemp -d -p ${DESK_ACTION_TMP:-/tmp}` && cp -RL $SRCDIR/. $B/ && chmod -R u+w $B && W=$B/w && mkdir -p $W/product/packages/server/client/public $W/product/packages/server/client/src $W/product/packages/cli/src $W/product/packages/engine/src/mcp $W/product/packages/engine/src/core $W/product/packages/server/src/util $W/product/packages/server/src/routes && cd $B && cp README.md $W/product/README.md && cp -R docs $W/product/docs && cp -R packages/server/client/public/fonts $W/product/packages/server/client/public/fonts && cp packages/server/client/src/index.css packages/server/client/src/fonts.css $W/product/packages/server/client/src/ && cp packages/cli/package.json $W/product/packages/cli/ && cp packages/cli/src/mcp.ts $W/product/packages/cli/src/ && cp packages/engine/src/mcp/tools.ts $W/product/packages/engine/src/mcp/ && cp packages/engine/src/core/live-session-scan.ts $W/product/packages/engine/src/core/ && cp packages/server/src/util/entitlements.ts packages/server/src/util/billing.ts $W/product/packages/server/src/util/ && cp packages/server/src/routes/licence.ts $W/product/packages/server/src/routes/ && mkdir -p $W/web-standards && cp -R $P/site-src $W/site-src && cp -R $P/web-standards/bin $W/web-standards/bin && rm -rf $W/site-src/node_modules $W/site-src/docs-site/node_modules && chmod -R u+w $W && mkdir -p $B/home && printf '#!/bin/sh\\nexport TMPDIR=/tmp\\nexec chromium --no-sandbox \"$@\"\\n' > $B/chrome && chmod 755 $B/chrome && cd $W && (cd site-src && npm ci --no-audit --no-fund --loglevel=error) && (cd site-src/docs-site && npm ci --no-audit --no-fund --loglevel=error) && CLIENT_DIR=$W/product/packages/server/client DIST_DIR=$W/overlay/site REQUIRE_LEGAL=1 node site-src/build-marketing.mjs && test -s overlay/site/terms/index.html && test -s overlay/site/privacy/index.html && node web-standards/bin/seo-audit.mjs --dist overlay/site --config site-src/seo.config.json && node site-src/check-parity.mjs product && node site-src/check-links.mjs --dist overlay/site && (cd site-src && HOME=$B/home CHROME=$B/chrome CLIENT_DIR=$W/product/packages/server/client node render-cards.mjs --check) && cp $R/reference.json product/reference.json && (cd site-src/docs-site && PRODUCT_DIR=$W/product npm run build && cp -r build $W/overlay/site/docs) && test -s overlay/site/docs/index.html && mkdir -p $O && cp -R overlay/site/. $O/",
)

# The root of the cloud image layer: the self-host root, with the cloud client and the overlay of the site in /app/client.
action(
    name = "cloud-image",
    srcs = [],
    deps = {"base": ":selfhost-image", "client": ":client_dist_cloud", "site": ":site_overlay"},
    out = "cloud-image",
    directory = True,
    cmd = "O=`realpath -m $OUT` && B=`realpath $DEP_base` && C=`realpath $DEP_client` && S=`realpath $DEP_site` && mkdir -p $O && cp -R $B/. $O/ && chmod -R u+w $O && rm -rf $O/app/client && mkdir -p $O/app/client && cp -R $C/. $O/app/client/ && chmod -R u+w $O/app/client && cp -R $S/. $O/app/client/ && chmod -R u+w $O/app/client",
)

filegroup(name = "check", srcs = CHECKS)

# `marketing-kit modules` runs on the installed packages, as a cached action (munhq/desk#244): the check `modules` builds it.
node_action(name = "modules", srcs = SOURCES, cmd = "npx marketing-kit modules .", priority = 1)
