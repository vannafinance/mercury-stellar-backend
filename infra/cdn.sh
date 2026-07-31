#!/usr/bin/env bash
# Global external Application Load Balancer + Cloud CDN in front of a Cloud Run
# service. This is what restores the edge caching the app already asks for.
#
# Every API route already sends `Cache-Control: public, s-maxage=N,
# stale-while-revalidate=M`. On Cloud Run alone nothing reads those headers, so
# each visitor triggers the full origin work (e.g. the 200-account RPC fan-out in
# /api/analytics/accounts). USE_ORIGIN_HEADERS below makes Cloud CDN honour the
# existing s-maxage values, so no application code changes.
#
#   bash infra/cdn.sh                      # dev  -> test.stellar.vanna.finance
#   ENV=prod bash infra/cdn.sh             # prod -> app.stellar.vanna.finance
#
# Idempotent: every create is guarded. Excluded from the image by .dockerignore.

set -euo pipefail

PROJECT_ID=vanna-main
REGION=us-central1
ENV="${ENV:-dev}"

case "$ENV" in
  dev)  SERVICE=vanna-app-dev;  DOMAIN=test.stellar.vanna.finance; NAME=vanna-dev  ;;
  prod) SERVICE=vanna-app-prod; DOMAIN=app.stellar.vanna.finance;  NAME=vanna-prod ;;
  *) echo "ENV must be dev or prod" >&2; exit 1 ;;
esac

# Longest stale-while-revalidate the app actually asks for is 900s (Hubble
# /stats), the most common is 120s. Cloud CDN applies serve-while-stale per
# BACKEND SERVICE, not per route, so per-route granularity is lost — 120 matches
# the majority of routes. Raising it would let /api/pools serve staler data than
# the route intends.
SERVE_WHILE_STALE=120

say() { printf '\n=== %s ===\n' "$1"; }
has() { eval "$1" >/dev/null 2>&1; }

gcloud config set project "$PROJECT_ID" >/dev/null

say "1/8 Serverless NEG -> Cloud Run ${SERVICE}"
has "gcloud compute network-endpoint-groups describe ${NAME}-neg --region=$REGION" || \
  gcloud compute network-endpoint-groups create "${NAME}-neg" \
    --region="$REGION" \
    --network-endpoint-type=serverless \
    --cloud-run-service="$SERVICE"

say "2/8 Backend service with Cloud CDN"
# USE_ORIGIN_HEADERS is the whole point: obey the app's own s-maxage instead of
# imposing a blanket TTL. Routes that send `no-store` (every error path, and
# /api/analytics/accounts?force=1) stay uncached, which is the intended
# behaviour.
# No --protocol: setting it makes gcloud auto-resolve a portName, and serverless
# NEGs reject portName outright ("Port name is not supported for a backend
# service with Serverless network endpoint groups"), which fails the attach
# below. The LB-to-Cloud-Run hop is managed by Google regardless.
has "gcloud compute backend-services describe ${NAME}-backend --global" || \
  gcloud compute backend-services create "${NAME}-backend" \
    --global \
    --load-balancing-scheme=EXTERNAL_MANAGED \
    --enable-cdn \
    --cache-mode=USE_ORIGIN_HEADERS \
    --serve-while-stale="$SERVE_WHILE_STALE" \
    --compression-mode=AUTOMATIC

# GCP populates portName on the backend service even when --protocol is not
# passed, and the attach below rejects it. Stripping it via export/import works
# when protocol is HTTP: import has no HTTPS protocol to re-derive an https
# portName from, so the field stays clear long enough for the attach to land.
# (GCP re-adds portName: http afterwards, which is harmless.)
#
# This does NOT rescue a service created with --protocol=HTTPS by an older
# version of this script — there, import regenerates portName: https every
# time. The assert below catches that case and prints the recreate sequence.
if gcloud compute backend-services describe "${NAME}-backend" --global \
     --format='value(portName)' 2>/dev/null | grep -q .; then
  echo "  clearing portName so the serverless NEG can attach"
  TMP="$(mktemp)"
  gcloud compute backend-services export "${NAME}-backend" --global --destination="$TMP"
  grep -v '^portName:' "$TMP" > "${TMP}.stripped"
  mv "${TMP}.stripped" "$TMP"
  gcloud compute backend-services import "${NAME}-backend" --global --source="$TMP" --quiet
  rm -f "$TMP"
fi

# Attaching is not idempotent, but do NOT swallow the error to get that —
# a backend service with no backend attached returns 502 for every request,
# and a suppressed failure here looks identical to success. Check, then add.
if ! gcloud compute backend-services describe "${NAME}-backend" --global \
      --format='value(backends[].group)' 2>/dev/null | grep -q "${NAME}-neg"; then
  gcloud compute backend-services add-backend "${NAME}-backend" \
    --global \
    --network-endpoint-group="${NAME}-neg" \
    --network-endpoint-group-region="$REGION"
fi

# Assert rather than assume. Everything downstream reports success even when
# this is empty, and the symptom only shows up as a 502 an hour later once DNS
# and the certificate are done.
gcloud compute backend-services describe "${NAME}-backend" --global \
  --format='value(backends[].group)' | grep -q "${NAME}-neg" || {
    cat >&2 <<EOF

ERROR: ${NAME}-neg is not attached to ${NAME}-backend, so the load balancer
would return 502 for every request.

The usual cause is a backend service created by an older version of this
script that passed --protocol=HTTPS: export/import regenerates portName
from the protocol field, so it cannot be repaired in place. Delete it and
its dependents, then re-run. The reserved IP, certificate, NEG and HTTP
redirect all survive, so DNS does not change:

  gcloud compute forwarding-rules     delete ${NAME}-fr           --global --quiet
  gcloud compute target-https-proxies delete ${NAME}-https-proxy  --global --quiet
  gcloud compute url-maps             delete ${NAME}-urlmap       --global --quiet
  gcloud compute backend-services     delete ${NAME}-backend      --global --quiet
  bash infra/cdn.sh

EOF
    exit 1
  }

say "3/8 Reserved anycast IP"
has "gcloud compute addresses describe ${NAME}-ip --global" || \
  gcloud compute addresses create "${NAME}-ip" --global --ip-version=IPV4
LB_IP=$(gcloud compute addresses describe "${NAME}-ip" --global --format='value(address)')

say "4/8 URL map"
has "gcloud compute url-maps describe ${NAME}-urlmap --global" || \
  gcloud compute url-maps create "${NAME}-urlmap" \
    --default-service="${NAME}-backend" --global

say "5/8 HTTP -> HTTPS redirect on the same IP"
has "gcloud compute url-maps describe ${NAME}-redirect --global" || \
  gcloud compute url-maps import "${NAME}-redirect" --global --quiet --source=/dev/stdin <<EOF
name: ${NAME}-redirect
defaultUrlRedirect:
  redirectResponseCode: MOVED_PERMANENTLY_DEFAULT
  httpsRedirect: true
EOF

has "gcloud compute target-http-proxies describe ${NAME}-http-proxy --global" || \
  gcloud compute target-http-proxies create "${NAME}-http-proxy" \
    --url-map="${NAME}-redirect" --global

has "gcloud compute forwarding-rules describe ${NAME}-fr-http --global" || \
  gcloud compute forwarding-rules create "${NAME}-fr-http" \
    --global \
    --load-balancing-scheme=EXTERNAL_MANAGED \
    --target-http-proxy="${NAME}-http-proxy" \
    --address="${NAME}-ip" \
    --ports=80

say "6/8 DNS gate"
# The certificate below cannot be created usefully until DNS already points at
# LB_IP. Google validates on creation; if the record is not live yet the domain
# lands in FAILED_NOT_VISIBLE, and it retries on its own schedule — hours, not
# minutes. Recovering means deleting and recreating the certificate.
#
# So stop here instead, print the record, and let the operator re-run. Exit 0:
# this is an expected intermediate state, not a failure.
resolve_a() {
  if command -v dig >/dev/null 2>&1; then
    dig +short A "$1" @8.8.8.8 2>/dev/null | grep -E '^[0-9.]+$' | head -1
  else
    getent ahostsv4 "$1" 2>/dev/null | awk '{print $1; exit}'
  fi
}

CURRENT_A="$(resolve_a "$DOMAIN")"
if [ "$CURRENT_A" != "$LB_IP" ]; then
  cat <<EOF

  $DOMAIN currently resolves to: ${CURRENT_A:-<nothing>}
  It needs to resolve to:        $LB_IP

  Add this record, wait for it to propagate, then re-run this script:

    A    $DOMAIN    $LB_IP    (TTL 60)

  Everything except the TLS certificate and the HTTPS frontend is already in
  place. Re-running skips all of it and picks up from here.

EOF
  exit 0
fi
echo "  $DOMAIN -> $CURRENT_A, matches the load balancer"

say "7/8 Google-managed TLS certificate for ${DOMAIN}"
has "gcloud compute ssl-certificates describe ${NAME}-cert --global" || \
  gcloud compute ssl-certificates create "${NAME}-cert" \
    --domains="$DOMAIN" --global

has "gcloud compute target-https-proxies describe ${NAME}-https-proxy --global" || \
  gcloud compute target-https-proxies create "${NAME}-https-proxy" \
    --url-map="${NAME}-urlmap" \
    --ssl-certificates="${NAME}-cert" \
    --global

has "gcloud compute forwarding-rules describe ${NAME}-fr --global" || \
  gcloud compute forwarding-rules create "${NAME}-fr" \
    --global \
    --load-balancing-scheme=EXTERNAL_MANAGED \
    --target-https-proxy="${NAME}-https-proxy" \
    --address="${NAME}-ip" \
    --ports=443

say "8/8 Done"
cat <<EOF
Environment:  $ENV
Service:      $SERVICE ($REGION)
Domain:       $DOMAIN
Load balancer IP: $LB_IP

NEXT — point DNS at the load balancer:

  A    $DOMAIN    $LB_IP

The managed certificate stays PROVISIONING until that record resolves, then
goes ACTIVE by itself. Check with:

  gcloud compute ssl-certificates describe ${NAME}-cert --global \\
    --format='value(managed.status, managed.domainStatus)'

Once ACTIVE, verify caching is actually working:

  curl -sSI https://$DOMAIN/api/pools | grep -iE 'age|cache-control|via'

Second request within 30s should show a non-zero \`Age\` and \`Via: 1.1 google\`.
That is the GCP equivalent of watching x-vercel-cache flip to HIT.
EOF
