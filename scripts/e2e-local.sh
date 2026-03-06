#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ADAPTER_BUN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# Place workspace outside the adapter-bun tree so bun.lock doesn't
# get detected as a workspace root by Next.js turbo/bundler.
WORKSPACE="${ADAPTER_BUN_DIR}/../.adapter-bun-e2e"
NEXTJS_DIR="$WORKSPACE/next.js"
NEXTJS_REF="${1:-canary}"
TEST_FILE="${2:-test/e2e/app-dir/app/index.test.ts}"

echo "=== adapter-bun local e2e test runner ==="
echo "Adapter dir:  $ADAPTER_BUN_DIR"
echo "Workspace:    $WORKSPACE"
echo "Next.js ref:  $NEXTJS_REF"
echo "Test file:    $TEST_FILE"
echo ""

# ── Step 1: Clone or update Next.js ──
if [ -d "$NEXTJS_DIR/.git" ]; then
  echo ">>> Next.js repo exists, fetching..."
  cd "$NEXTJS_DIR"
  git fetch origin "$NEXTJS_REF" --depth=25
  git checkout FETCH_HEAD
else
  echo ">>> Cloning vercel/next.js (ref: $NEXTJS_REF)..."
  mkdir -p "$WORKSPACE"
  git clone --depth=25 --branch "$NEXTJS_REF" https://github.com/vercel/next.js.git "$NEXTJS_DIR"
fi

# ── Step 2: Install & build Next.js ──
cd "$NEXTJS_DIR"
echo ">>> Installing Next.js dependencies (pnpm install)..."
corepack enable
pnpm install

echo ">>> Building Next.js (pnpm build)..."
pnpm build

echo ">>> Re-linking after build (pnpm install)..."
pnpm install

# ── Step 3: Install Playwright ──
echo ">>> Installing Playwright chromium..."
pnpm playwright install --with-deps chromium

# ── Step 4: Build adapter-bun ──
echo ">>> Building adapter-bun..."
cd "$ADAPTER_BUN_DIR"
bun install
bun run build

# ── Step 5: Make scripts executable ──
chmod +x "$ADAPTER_BUN_DIR/scripts/e2e-deploy.sh" \
         "$ADAPTER_BUN_DIR/scripts/e2e-logs.sh" \
         "$ADAPTER_BUN_DIR/scripts/e2e-cleanup.sh"

# ── Step 6: Run the test ──
echo ""
echo ">>> Running test: $TEST_FILE"
echo ""
cd "$NEXTJS_DIR"

NEXT_TEST_MODE=deploy \
NEXT_E2E_TEST_TIMEOUT=240000 \
NEXT_EXTERNAL_TESTS_FILTERS="test/deploy-tests-manifest.json,$ADAPTER_BUN_DIR/test/deploy-tests-manifest.adapter-bun.json" \
NEXT_TEST_DEPLOY_SCRIPT_PATH="$ADAPTER_BUN_DIR/scripts/e2e-deploy.sh" \
NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH="$ADAPTER_BUN_DIR/scripts/e2e-logs.sh" \
NEXT_TEST_CLEANUP_SCRIPT_PATH="$ADAPTER_BUN_DIR/scripts/e2e-cleanup.sh" \
ADAPTER_BUN_DIR="$ADAPTER_BUN_DIR" \
IS_TURBOPACK_TEST=1 \
NEXT_TEST_JOB=1 \
NEXT_TELEMETRY_DISABLED=1 \
node run-tests.js --test-pattern "$TEST_FILE" -c 1 --debug
