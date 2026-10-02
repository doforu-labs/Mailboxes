#!/bin/bash
# Copyright (c) 2026 Doforu
# Licensed under the Apache 2.0 license found in the LICENSE file or at:
#     https://opensource.org/licenses/Apache-2.0
set -e

echo "🚀 Mailboxes Deploy"
echo "==================="

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

fail() { echo -e "${RED}❌ $1${NC}"; exit 1; }
ok()   { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }

# ── 1. Environment checks ──────────────────────────────────────
echo ""
echo "1️⃣  Environment checks..."

command -v node &>/dev/null || fail "Node.js not found"
echo "   Node.js: $(node -v)"

command -v npm &>/dev/null || fail "npm not found"
echo "   npm: $(npm -v)"

command -v npx &>/dev/null || fail "npx not found"

# Check wrangler version (v4+)
WRANGLER_VER=$(npx wrangler --version 2>/dev/null | head -1 || echo "not found")
echo "   Wrangler: $WRANGLER_VER"

# ── 2. Authentication ──────────────────────────────────────────
echo ""
echo "2️⃣  Checking Wrangler authentication..."
if npx wrangler whoami &>/dev/null 2>&1; then
    ok "Wrangler authenticated"
else
    fail "Not logged in to Wrangler. Run: npx wrangler login"
fi

# ── 3. Config validation ───────────────────────────────────────
echo ""
echo "3️⃣  Validating wrangler.json..."
WRANGLER_CONFIG="wrangler.jsonc"
[ ! -f "$WRANGLER_CONFIG" ] && WRANGLER_CONFIG="wrangler.json"
[ ! -f "$WRANGLER_CONFIG" ] && fail "No wrangler config found"

echo "   Config: $WRANGLER_CONFIG"
echo "   $(wc -l < "$WRANGLER_CONFIG") lines"
ok "$WRANGLER_CONFIG found"

# ── 4. Dry run ─────────────────────────────────────────────────
echo ""
echo "4️⃣  Wrangler dry-run..."
if npx wrangler deploy --dry-run 2>&1 | grep -qi "error"; then
    fail "Dry-run failed"
fi
ok "Dry-run passed"

# ── 5. Startup check ───────────────────────────────────────────
echo ""
echo "5️⃣  Checking worker startup time..."
if npx wrangler check startup 2>&1 | tail -1; then
    ok "Startup check done"
else
    warn "Startup check skipped"
fi

# ── 6. Build ───────────────────────────────────────────────────
echo ""
echo "6️⃣  Building..."
npm run build
ok "Build complete"

# ── 7. Deploy ──────────────────────────────────────────────────
echo ""
echo "7️⃣  Deploying to Cloudflare Workers..."
DEPLOY_OUTPUT=$(npx wrangler deploy 2>&1)
echo "$DEPLOY_OUTPUT" | grep -E "Uploaded|Deployed|https://|Error|Worker"
if echo "$DEPLOY_OUTPUT" | grep -qi "error"; then
    fail "Deployment failed"
fi
ok "Deployed"

# ── 8. Health check ────────────────────────────────────────────
echo ""
echo "8️⃣  Post-deploy health check..."
WORKER_URL=$(echo "$DEPLOY_OUTPUT" | grep -oE "https://[^ ]+" | head -1)
if [ -z "$WORKER_URL" ]; then
    warn "Could not determine the Worker URL from deploy output; skipping health check"
fi
echo "   URL: ${WORKER_URL:-<unknown>}"

if [ -n "$WORKER_URL" ]; then
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$WORKER_URL" --max-time 10 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "302" ]; then
        ok "Health check passed (HTTP $HTTP_CODE)"
    else
        warn "Health check returned HTTP $HTTP_CODE"
    fi
fi

# ── 9. Git commit & push ──────────────────────────────────────
echo ""
echo "9️⃣  Git commit & push..."
git add -A
if git diff --cached --quiet; then
    echo "   (no changes to commit)"
else
    git commit -m "deploy: $(date '+%Y-%m-%d %H:%M:%S')"
fi
git push origin main
ok "Git pushed"

# ── Done ───────────────────────────────────────────────────────
echo ""
echo "============================================"
echo -e "${GREEN}✅ Deployment complete!${NC}"
echo "   $WORKER_URL"
echo "============================================"
