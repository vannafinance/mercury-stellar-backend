#!/usr/bin/env bash
# Build and deploy the current `dev-credit-layer` commit to its own Cloud Run service
# (vanna-app-credit-layer → test.stellar.mainnet.vanna.finance), for testing the mainnet
# credit-layer contracts deployed on testnet.
#
# Same build as scripts/deploy-dev.sh, but a separate service and image, so test.stellar.vanna.finance
# (vanna-app-dev, old contracts) is never touched. Run from the repo root:  ./scripts/deploy-credit-layer.sh
#
# The first run only creates the service. The domain is set up once afterwards; see the end of this file.
set -euo pipefail

PROJECT_ID=vanna-main
REGION=us-central1
SERVICE=vanna-app-credit-layer
IMAGE=vanna-app-credit-layer
SITE_URL=https://test.stellar.mainnet.vanna.finance
DEPLOYER_SA=vanna-deployer@vanna-main.iam.gserviceaccount.com
MCP_BASE_URL=https://vanna-mcp-server-uscm2gn35a-uc.a.run.app/mcp
MCP_RESOURCE=https://mcp.vanna.finance/mcp
SIGN_CONNECT_BASE_URL=https://vanna-connect-gateway-uscm2gn35a-uc.a.run.app
BRANCH_REQUIRED=dev-credit-layer

cd "$(dirname "$0")/.."

# Privy app id: environment variable first, then .env (quotes stripped). Inlined at BUILD time.
PRIVY_APP_ID="${NEXT_PUBLIC_PRIVY_APP_ID:-}"
if [[ -z "$PRIVY_APP_ID" && -f .env ]]; then
  PRIVY_APP_ID=$(grep -E '^NEXT_PUBLIC_PRIVY_APP_ID=' .env | tail -1 | cut -d= -f2- | tr -d '"'"'"' \r')
fi
if [[ -z "$PRIVY_APP_ID" ]]; then
  echo "✗ NEXT_PUBLIC_PRIVY_APP_ID is empty (checked env and .env). Refusing to deploy a build without Privy." >&2
  exit 1
fi

# Deploy exactly what is on origin/dev-credit-layer, so the site always matches a pushed commit.
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "$BRANCH_REQUIRED" ]]; then
  echo "✗ On branch '$BRANCH'. Switch first: git checkout $BRANCH_REQUIRED" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "✗ Uncommitted changes. Commit and push them first (the build uploads the working tree)." >&2
  git status --short --untracked-files=no >&2
  exit 1
fi
git fetch -q origin "$BRANCH_REQUIRED"
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$BRANCH_REQUIRED")" ]]; then
  echo "✗ Local $BRANCH_REQUIRED ($(git rev-parse --short HEAD)) differs from origin ($(git rev-parse --short "origin/$BRANCH_REQUIRED"))." >&2
  echo "  Push or pull, then rerun." >&2
  exit 1
fi

TAG=$(git rev-parse --short=7 HEAD)
echo "→ Deploying $TAG to $SERVICE ($SITE_URL), Privy ${PRIVY_APP_ID:0:8}…"

gcloud builds submit \
  --project="$PROJECT_ID" \
  --config=cloudbuild.yaml \
  --region="$REGION" \
  --service-account="projects/$PROJECT_ID/serviceAccounts/$DEPLOYER_SA" \
  --substitutions="_TAG=$TAG,_IMAGE=$IMAGE,_SERVICE=$SERVICE,_REGION=$REGION,_SITE_URL=$SITE_URL,_PRIVY_APP_ID=$PRIVY_APP_ID,_MCP_BASE_URL=$MCP_BASE_URL,_MCP_RESOURCE=$MCP_RESOURCE,_SIGN_CONNECT_BASE_URL=$SIGN_CONNECT_BASE_URL" \
  .

echo "→ Live revision:"
gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" \
  --format='value(status.latestReadyRevisionName,status.url)'
echo "✓ Done. Hard-refresh $SITE_URL (Ctrl+Shift+R)."

# One-time domain setup (already done once it resolves; not run by this script):
#   gcloud beta run domain-mappings create --service=vanna-app-credit-layer \
#     --domain=test.stellar.mainnet.vanna.finance --project=vanna-main --region=us-central1
#   Then a CNAME test.stellar.mainnet → ghs.googlehosted.com. in the live vanna-finance zone
#   (project vanna-website). Google issues the certificate within ~15–60 minutes.
