#!/usr/bin/env bash
# One-time GCP setup for the Vanna app on Cloud Run. Run once, in Cloud Shell.
#
#   git clone https://github.com/vannafinance/mercury-stellar-backend.git
#   cd mercury-stellar-backend && git checkout dev
#   MERCURY_URL='...' MERCURY_KEY='...' bash infra/bootstrap.sh
#
# Idempotent: every create is guarded, so re-running is safe.
# Excluded from the container image by .dockerignore.

set -euo pipefail

PROJECT_ID=vanna-main
PROJECT_NUMBER=1079109217674
REGION=us-central1
REPO=vanna
GITHUB_REPO=vannafinance/mercury-stellar-backend

RUNTIME_SA="vanna-app-run@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOYER_SA="vanna-deployer@${PROJECT_ID}.iam.gserviceaccount.com"

say() { printf '\n=== %s ===\n' "$1"; }

# A freshly created service account is not immediately visible to the project
# IAM policy service, which rejects the binding with "does not exist" even
# though the account was just created successfully. Retry rather than fail.
bind_role() {
  local member="$1" role="$2" i
  for i in $(seq 1 12); do
    if gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="$member" --role="$role" --condition=None >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
  done
  echo "  FAILED to bind $role to $member" >&2
  return 1
}

# Same race, but for a binding ON a service account rather than on the project.
bind_sa_role() {
  local target="$1" member="$2" role="$3" i
  for i in $(seq 1 12); do
    if gcloud iam service-accounts add-iam-policy-binding "$target" \
        --member="$member" --role="$role" >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
  done
  echo "  FAILED to bind $role to $member on $target" >&2
  return 1
}

gcloud config set project "$PROJECT_ID" >/dev/null

say "1/7 Enabling APIs (a few minutes on first run)"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  bigquery.googleapis.com \
  compute.googleapis.com

say "2/7 Artifact Registry"
gcloud artifacts repositories describe "$REPO" --location="$REGION" >/dev/null 2>&1 || \
  gcloud artifacts repositories create "$REPO" \
    --repository-format=docker \
    --location="$REGION" \
    --description="Vanna app container images"

say "3/7 Runtime service account (what Cloud Run runs as)"
gcloud iam service-accounts describe "$RUNTIME_SA" >/dev/null 2>&1 || \
  gcloud iam service-accounts create vanna-app-run \
    --display-name="Vanna app runtime"

# bigquery.jobUser lets it create query jobs billed to this project. Hubble
# itself (crypto-stellar.crypto_stellar) is SDF's PUBLIC dataset, so no read
# grant is needed — this project is only the billing/quota anchor.
for ROLE in bigquery.jobUser secretmanager.secretAccessor; do
  bind_role "serviceAccount:${RUNTIME_SA}" "roles/${ROLE}"
done

say "4/7 Deployer service account (what GitHub Actions acts as)"
gcloud iam service-accounts describe "$DEPLOYER_SA" >/dev/null 2>&1 || \
  gcloud iam service-accounts create vanna-deployer \
    --display-name="GitHub Actions deployer"

# storage.admin is broader than ideal — it is what `gcloud builds submit` needs
# to upload the source tarball to the auto-created staging bucket. Worth
# scoping to that one bucket later.
for ROLE in cloudbuild.builds.editor logging.logWriter artifactregistry.writer run.admin storage.admin; do
  bind_role "serviceAccount:${DEPLOYER_SA}" "roles/${ROLE}"
done

# Deploying a service that runs as RUNTIME_SA requires actAs on it...
bind_sa_role "$RUNTIME_SA" "serviceAccount:${DEPLOYER_SA}" "roles/iam.serviceAccountUser"

# ...and submitting a build that runs as itself requires actAs on itself.
bind_sa_role "$DEPLOYER_SA" "serviceAccount:${DEPLOYER_SA}" "roles/iam.serviceAccountUser"

say "5/7 Workload Identity Federation for GitHub"
gcloud iam workload-identity-pools describe github --location=global >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools create github \
    --location=global --display-name="GitHub Actions"

# The attribute-condition is the security boundary: without it ANY GitHub repo
# on the internet could mint a token for this service account.
gcloud iam workload-identity-pools providers describe github \
  --location=global --workload-identity-pool=github >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools providers create-oidc github \
    --location=global \
    --workload-identity-pool=github \
    --display-name="GitHub" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository == '${GITHUB_REPO}'"

bind_sa_role "$DEPLOYER_SA" \
  "principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository/${GITHUB_REPO}" \
  "roles/iam.workloadIdentityUser"

say "6/7 Secrets"
put_secret() {
  local name="$1" value="${2:-}"
  if [[ -z "$value" ]]; then
    echo "  SKIP $name — not exported. Set it later with:"
    echo "    printf '%s' 'VALUE' | gcloud secrets versions add $name --data-file=-"
    gcloud secrets describe "$name" >/dev/null 2>&1 || \
      gcloud secrets create "$name" --replication-policy=automatic >/dev/null
    return
  fi
  gcloud secrets describe "$name" >/dev/null 2>&1 || \
    gcloud secrets create "$name" --replication-policy=automatic >/dev/null
  printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- >/dev/null
  echo "  set $name"
}
put_secret MERCURY_URL "${MERCURY_URL:-}"
put_secret MERCURY_KEY "${MERCURY_KEY:-}"

say "7/7 Done"
cat <<EOF
Region:        $REGION
Registry:      ${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}
Runtime SA:    $RUNTIME_SA
Deployer SA:   $DEPLOYER_SA
WIF provider:  projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/providers/github

Next: push the dev branch. .github/workflows/deploy-dev.yml takes over from there.

If the deploy fails on --allow-unauthenticated with a policy error, the org
enforces domain-restricted sharing and the founder must allow allUsers for
this project. That is the one thing this script cannot grant itself.
EOF
