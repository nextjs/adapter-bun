#!/usr/bin/env bash
set -euo pipefail

cd "$NEXT_TEST_DIR"

if [ -z "${ADAPTER_BUN_DIR:-}" ]; then
  echo "ADAPTER_BUN_DIR is not set" >&2
  exit 1
fi

if [ ! -d "$ADAPTER_BUN_DIR" ]; then
  echo "ADAPTER_BUN_DIR does not exist: $ADAPTER_BUN_DIR" >&2
  exit 1
fi

ADAPTER_BUN_DIR="$(cd "$ADAPTER_BUN_DIR" && pwd -P)"
export ADAPTER_BUN_DIR
ADAPTER_BUN_DIST_INDEX="${ADAPTER_BUN_DIR}/dist/index.js"
ADAPTER_PACK_LOCK_DIR="${ADAPTER_BUN_DIR}/.e2e-deploy-pack.lock"
adapter_pack_lock_acquired=0

cleanup_adapter_pack_lock() {
  if [ "$adapter_pack_lock_acquired" -eq 1 ]; then
    rmdir "$ADAPTER_PACK_LOCK_DIR" 2>/dev/null || true
    adapter_pack_lock_acquired=0
  fi
}

trap cleanup_adapter_pack_lock EXIT

# Multiple deploy tests run in parallel and share ADAPTER_BUN_DIR.
# Serialize pack/build access so one test cannot remove dist while another
# is packing or resolving NEXT_ADAPTER_PATH.
for _attempt in $(seq 1 300); do
  if mkdir "$ADAPTER_PACK_LOCK_DIR" 2>/dev/null; then
    adapter_pack_lock_acquired=1
    break
  fi
  sleep 0.1
done

if [ "$adapter_pack_lock_acquired" -ne 1 ]; then
  echo "Timed out waiting for adapter pack lock: ${ADAPTER_PACK_LOCK_DIR}" >&2
  exit 1
fi

# Test jobs restore adapter-bun from cache. If dist artifacts are missing,
# rebuild in-place so NEXT_ADAPTER_PATH always points at a valid module.
if [ ! -f "$ADAPTER_BUN_DIST_INDEX" ]; then
  echo "Adapter dist missing at ${ADAPTER_BUN_DIST_INDEX}; rebuilding adapter-bun..." >&2
  (
    cd "$ADAPTER_BUN_DIR"
    bun install >&2
    bun run build >&2
  )
fi

if [ ! -f "$ADAPTER_BUN_DIST_INDEX" ]; then
  echo "Adapter dist build failed; missing ${ADAPTER_BUN_DIST_INDEX}" >&2
  exit 1
fi

# 1. Pick a random available port
PORT=$(node -e "const s=require('net').createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})")

# 2. Pack adapter-bun and add it as a tarball dependency. Installing the raw
# repo directory pulls fixture file: links into the temp app and can recurse.
PACK_RESULT="$(
  cd "$ADAPTER_BUN_DIR"
  npm pack --json --ignore-scripts --pack-destination "$NEXT_TEST_DIR"
)"
ADAPTER_BUN_TARBALL="$NEXT_TEST_DIR/$(
  node -e "const result = JSON.parse(process.argv[1]); console.log(result[0].filename)" "$PACK_RESULT"
)"
cleanup_adapter_pack_lock

# 3. Add adapter-bun as dependency
node -e "
const pkg=JSON.parse(require('fs').readFileSync('package.json','utf8'));
pkg.dependencies=pkg.dependencies||{};
pkg.dependencies['adapter-bun']='file:${ADAPTER_BUN_TARBALL}';
require('fs').writeFileSync('package.json',JSON.stringify(pkg,null,2));
" >&2

# 4. Install dependencies
bun install --no-frozen-lockfile >&2

# Bun type packages can conflict with Next.js global typings in fixtures
# without explicit tsconfig "types". Remove them for deploy test builds.
if [ -d "node_modules/bun-types" ]; then
  rm -rf "node_modules/bun-types"
fi
if [ -d "node_modules/@types/bun" ]; then
  rm -rf "node_modules/@types/bun"
fi

# 5. Set adapter path
NEXT_ADAPTER_PATH_LOCAL="${NEXT_TEST_DIR}/node_modules/adapter-bun/dist/index.js"
if [ ! -f "$NEXT_ADAPTER_PATH_LOCAL" ]; then
  echo "Installed adapter dist missing: ${NEXT_ADAPTER_PATH_LOCAL}" >&2
  exit 1
fi
export NEXT_ADAPTER_PATH="$NEXT_ADAPTER_PATH_LOCAL"
# Next's deploy harness aliases NEXT_PRIVATE_TEST_MODE -> __NEXT_TEST_MODE
# in next.config.js for test-only hydration markers. Ensure it's set so
# browser hydration waits don't fall back to a 10s timeout per navigation.
if [ -z "${NEXT_PRIVATE_TEST_MODE:-}" ] && [ -n "${NEXT_TEST_MODE:-}" ]; then
  export NEXT_PRIVATE_TEST_MODE="${NEXT_TEST_MODE}"
fi

# 6. Build (NEXT_ADAPTER_PATH tells Next.js to use our adapter).
# The Next.js test harness always wires a `build` script in package.json.
# Execute that script, but force `next build` segments to run through Bun.
: > "$NEXT_TEST_DIR/.adapter-build.log"

BUILD_SCRIPT="$(
  node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const build = pkg?.scripts?.build;
if (typeof build === 'string' && build.trim().length > 0) {
  const normalized = build.replace(/\\bnext\\s+build\\b/g, 'bun --bun next build');
  console.log(normalized);
}
" 2>/dev/null || true
)"

if [ -z "$BUILD_SCRIPT" ]; then
  echo 'Missing package.json scripts.build in deploy test dir' >&2
  exit 1
fi

# Generate a stable deployment ID before the build so it is baked into
# client bundles and used consistently at runtime.
DEPLOY_RANDOM=$(node -e "console.log(require('crypto').randomBytes(8).toString('base64url'))")
export NEXT_DEPLOYMENT_ID="bun-adapter-${DEPLOY_RANDOM}"
export VERCEL_IMMUTABLE_ASSET_TOKEN="$NEXT_DEPLOYMENT_ID"
export IMMUTABLE_ASSET_TOKEN="$NEXT_DEPLOYMENT_ID"

# Forward experimental feature flags from the test harness.
if [ -n "${__NEXT_CACHE_COMPONENTS:-}" ]; then
  export NEXT_PRIVATE_EXPERIMENTAL_CACHE_COMPONENTS="${__NEXT_CACHE_COMPONENTS}"
fi
if [ -n "${NEXT_PRIVATE_EXPERIMENTAL_CACHE_COMPONENTS:-}" ]; then
  export __NEXT_CACHE_COMPONENTS="${NEXT_PRIVATE_EXPERIMENTAL_CACHE_COMPONENTS}"
fi

bash -lc "$BUILD_SCRIPT" 2>&1 | tee -a "$NEXT_TEST_DIR/.adapter-build.log" >&2

# 7. Record build ID markers for logs script
BUILD_ID=$(cat ".next/BUILD_ID" 2>/dev/null || echo "unknown")
echo "BUILD_ID: $BUILD_ID" >> "$NEXT_TEST_DIR/.adapter-build.log"
echo "DEPLOYMENT_ID: $NEXT_DEPLOYMENT_ID" >> "$NEXT_TEST_DIR/.adapter-build.log"
echo "IMMUTABLE_ASSET_TOKEN: $IMMUTABLE_ASSET_TOKEN" >> "$NEXT_TEST_DIR/.adapter-build.log"

# 8. Start server on selected port
# Use bun (without --bun) for better Node.js API compatibility with Next.js internals
PORT=$PORT NEXT_DEPLOYMENT_ID="$NEXT_DEPLOYMENT_ID" VERCEL_IMMUTABLE_ASSET_TOKEN="$VERCEL_IMMUTABLE_ASSET_TOKEN" IMMUTABLE_ASSET_TOKEN="$IMMUTABLE_ASSET_TOKEN" bun bun-dist/server.js >> "$NEXT_TEST_DIR/.adapter-server.log" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$NEXT_TEST_DIR/.adapter-server.pid"

# 9. Wait for server to be ready.
# Use a plain TCP probe instead of an HTTP route probe so middleware fixtures
# are not exercised during readiness checks.
server_ready=0
for i in $(seq 1 30); do
  if PORT="$PORT" node -e "
const net = require('node:net');
const port = Number(process.env.PORT);
const socket = net.connect({ host: '127.0.0.1', port });
const done = (ok) => {
  socket.destroy();
  process.exit(ok ? 0 : 1);
};
socket.once('connect', () => done(true));
socket.once('error', () => done(false));
setTimeout(() => done(false), 750);
" >/dev/null 2>&1; then
    server_ready=1
    break
  fi

  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Server died. Logs:" >&2
    cat "$NEXT_TEST_DIR/.adapter-server.log" >&2
    exit 1
  fi
  sleep 1
done

if [ "$server_ready" -ne 1 ]; then
  echo "Server did not become ready within timeout. Logs:" >&2
  cat "$NEXT_TEST_DIR/.adapter-server.log" >&2
  exit 1
fi

# 10. Output URL (only thing on stdout)
echo "http://localhost:${PORT}"
