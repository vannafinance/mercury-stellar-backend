#!/usr/bin/env bash
# Build and deploy the current `dev` commit to Cloud Run (vanna-app-dev → test.stellar.vanna.finance).
#
# Same build as .github/workflows/deploy-dev.yml, run from a laptop with your own gcloud login.
# Usage (from the repo root):  ./scripts/deploy-dev.sh
#
# NEXT_PUBLIC_PRIVY_APP_ID is inlined into the client bundle at BUILD time. An empty value builds
# an app with Privy sign-in hidden (only Freighter shows), so this script refuses to deploy without
# it instead of silently shipping a Freighter-only build.
set -euo pipefail

PROJECT_ID=vanna-main
REGION=us-central1
SERVICE=vanna-app-dev
SITE_URL=https://test.stellar.vanna.finance
DEPLOYER_SA=vanna-deployer@vanna-main.iam.gserviceaccount.com
MCP_BASE_URL=https://vanna-mcp-server-uscm2gn35a-uc.a.run.app/mcp
MCP_RESOURCE=https://mcp.vanna.finance/mcp
SIGN_CONNECT_BASE_URL=https://vanna-connect-gateway-uscm2gn35a-uc.a.run.app

cd "$(dirname "$0")/.."

# Privy app id: environment variable first, then .env (quotes stripped).
PRIVY_APP_ID="${NEXT_PUBLIC_PRIVY_APP_ID:-}"
if [[ -z "$PRIVY_APP_ID" && -f .env ]]; then
  PRIVY_APP_ID=$(grep -E '^NEXT_PUBLIC_PRIVY_APP_ID=' .env | tail -1 | cut -d= -f2- | tr -d '"'"'"' \r')
fi
if [[ -z "$PRIVY_APP_ID" ]]; then
  echo "✗ NEXT_PUBLIC_PRIVY_APP_ID is empty (checked env and .env). Refusing to deploy a build without Privy." >&2
  exit 1
fi

# Deploy exactly what is on origin/dev, so the live site always matches a pushed commit.
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "dev" ]]; then
  echo "✗ On branch '$BRANCH'. Switch to dev first: git checkout dev" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "✗ Uncommitted changes. Commit and push them first (the build uploads the working tree)." >&2
  git status --short --untracked-files=no >&2
  exit 1
fi
git fetch -q origin dev
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/dev)" ]]; then
  echo "✗ Local dev ($(git rev-parse --short HEAD)) differs from origin/dev ($(git rev-parse --short origin/dev))." >&2
  echo "  Push your commits (git push origin dev) or pull (git pull), then rerun." >&2
  exit 1
fi

TAG=$(git rev-parse --short=7 HEAD)
echo "→ Deploying $TAG to $SERVICE ($SITE_URL), Privy ${PRIVY_APP_ID:0:8}…"

gcloud builds submit \
  --project="$PROJECT_ID" \
  --config=cloudbuild.yaml \
  --region="$REGION" \
  --service-account="projects/$PROJECT_ID/serviceAccounts/$DEPLOYER_SA" \
  --substitutions="_TAG=$TAG,_SERVICE=$SERVICE,_REGION=$REGION,_SITE_URL=$SITE_URL,_PRIVY_APP_ID=$PRIVY_APP_ID,_MCP_BASE_URL=$MCP_BASE_URL,_MCP_RESOURCE=$MCP_RESOURCE,_SIGN_CONNECT_BASE_URL=$SIGN_CONNECT_BASE_URL" \
  .

echo "→ Live revision:"
gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" \
  --format='value(status.latestReadyRevisionName,spec.template.spec.containers[0].image)'
echo "✓ Done. Hard-refresh $SITE_URL (Ctrl+Shift+R)."
