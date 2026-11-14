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

filegroup(name = "check", srcs = CHECKS)
