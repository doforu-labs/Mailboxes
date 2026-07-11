#!/bin/bash
set -e

echo "🚀 Mailboxes Deploy"
echo "==================="

# Check wrangler is available
if ! command -v npx &> /dev/null; then
    echo "❌ npx not found. Please install Node.js."
    exit 1
fi

# Check wrangler login status
echo "1️⃣  Checking Wrangler authentication..."
if ! npx wrangler whoami &> /dev/null; then
    echo "❌ Not logged in to Wrangler. Run: npx wrangler login"
    exit 1
fi

# Build
echo "2️⃣  Building..."
npm run build

# Deploy
echo "3️⃣  Deploying to Cloudflare Workers..."
npx wrangler deploy 2>&1 | grep -E "Uploaded|Deployed|https://|Error"

# Push to git
echo "4️⃣  Pushing to GitHub..."
git add -A
if git diff --cached --quiet; then
    echo "   (no changes to commit)"
else
    git commit -m "deploy: $(date '+%Y-%m-%d %H:%M:%S')"
fi
git push origin main

echo ""
echo "✅ Done! https://mailboxes.example.workers.dev"
