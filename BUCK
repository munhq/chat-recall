# The tests of chat-recall as Buck2 targets (munhq/desk#244): each shard of vitest is an action on declared inputs, so
# NativeLink serves the result of a shard whose inputs did not change, and the shards run in parallel on the workers. The
# rules are the workflow buck-node, mounted by `checkouts` of .desk/config.json. The check is //:check.
load("@desk_node//:defs.bzl", "node_action", "node_modules", "vitest_shards")

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

filegroup(name = "check", srcs = CHECKS)
