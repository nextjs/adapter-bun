#!/usr/bin/env bash
set -euo pipefail

cd "$NEXT_TEST_DIR"

# 1. Pick a random available port
PORT=$(node -e "const s=require('net').createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})")

# 2. Add adapter-bun as file: dependency
node -e "
const pkg=JSON.parse(require('fs').readFileSync('package.json','utf8'));
pkg.dependencies=pkg.dependencies||{};
pkg.dependencies['adapter-bun']='file:${ADAPTER_BUN_DIR}';
require('fs').writeFileSync('package.json',JSON.stringify(pkg,null,2));
" >&2

# 3. Install dependencies
bun install --no-frozen-lockfile >&2

# Bun type packages can conflict with Next.js global typings in fixtures
# without explicit tsconfig "types". Remove them for deploy test builds.
if [ -d "node_modules/bun-types" ]; then
  rm -rf "node_modules/bun-types"
fi
if [ -d "node_modules/@types/bun" ]; then
  rm -rf "node_modules/@types/bun"
fi

# Trim local-fixture trees from file:adapter installs. They are not needed for
# deploy tests and can create ENAMETOOLONG paths during test cleanup.
if [ -d "node_modules/adapter-bun/fixtures" ]; then
  rm -rf "node_modules/adapter-bun/fixtures"
fi

# 4. Set adapter path
export NEXT_ADAPTER_PATH="${ADAPTER_BUN_DIR}/dist/index.js"
# Next's deploy harness aliases NEXT_PRIVATE_TEST_MODE -> __NEXT_TEST_MODE
# in next.config.js for test-only hydration markers. Ensure it's set so
# browser hydration waits don't fall back to a 10s timeout per navigation.
if [ -z "${NEXT_PRIVATE_TEST_MODE:-}" ] && [ -n "${NEXT_TEST_MODE:-}" ]; then
  export NEXT_PRIVATE_TEST_MODE="${NEXT_TEST_MODE}"
fi

# 5. Build (NEXT_ADAPTER_PATH tells Next.js to use our adapter).
# Run fixture setup/post-build hooks when present, but always execute the core
# Next build through Bun so adapter hooks can use Bun-only APIs.
: > "$NEXT_TEST_DIR/.adapter-build.log"

has_script() {
  local script_name="$1"
  node -e "
const pkg=JSON.parse(require('fs').readFileSync('package.json','utf8'));
process.exit(pkg.scripts && pkg.scripts['$script_name'] ? 0 : 1);
" >/dev/null 2>&1
}

if has_script "setup"; then
  bun run setup >&2
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

bun --bun next build 2>&1 | tee -a "$NEXT_TEST_DIR/.adapter-build.log" >&2

if has_script "post-build"; then
  bun run post-build >&2
fi

# 6. Record build ID markers for logs script
BUILD_ID=$(cat ".next/BUILD_ID" 2>/dev/null || echo "unknown")
echo "BUILD_ID: $BUILD_ID" >> "$NEXT_TEST_DIR/.adapter-build.log"
echo "DEPLOYMENT_ID: $NEXT_DEPLOYMENT_ID" >> "$NEXT_TEST_DIR/.adapter-build.log"
echo "IMMUTABLE_ASSET_TOKEN: $IMMUTABLE_ASSET_TOKEN" >> "$NEXT_TEST_DIR/.adapter-build.log"

# 7. Start server on selected port
# Use bun (without --bun) for better Node.js API compatibility with Next.js internals
PORT=$PORT NEXT_DEPLOYMENT_ID="$NEXT_DEPLOYMENT_ID" VERCEL_IMMUTABLE_ASSET_TOKEN="$VERCEL_IMMUTABLE_ASSET_TOKEN" IMMUTABLE_ASSET_TOKEN="$IMMUTABLE_ASSET_TOKEN" bun bun-dist/server.js >> "$NEXT_TEST_DIR/.adapter-server.log" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$NEXT_TEST_DIR/.adapter-server.pid"

# 8. Wait for server to be ready
for i in $(seq 1 30); do
  if curl -sf -o /dev/null "http://localhost:${PORT}/" 2>/dev/null; then break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "Server died. Logs:" >&2
      cat "$NEXT_TEST_DIR/.adapter-server.log" >&2
      exit 1
    fi
  sleep 1
done

# 9. Output URL (only thing on stdout)
echo "http://localhost:${PORT}"
