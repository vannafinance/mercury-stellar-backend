#!/usr/bin/env bash
# Delegate a single Stellar hostname to Google Cloud DNS.
#
#   bash infra/dns.sh                # test.stellar.vanna.finance -> dev LB
#   ENV=prod bash infra/dns.sh       # app.stellar.vanna.finance  -> prod LB
#
# WHY PER-HOSTNAME, NOT THE WHOLE stellar.vanna.finance SUBTREE
# Delegating the subtree would make stellar.vanna.finance the apex of the new
# zone — and that is a live site belonging to a different Vercel project
# (stellar-backend). DNS forbids CNAME at a zone apex, so we would have to
# hardcode Vercel's anycast A records for a site we do not own. Those addresses
# rotate, and when they did, someone else's production would break with no
# obvious cause. Delegating one hostname at a time keeps that responsibility
# where it already is.
#
# The parent vanna.finance zone stays on Vercel regardless: it carries the
# Google Workspace MX record and nine other projects' subdomains. One NS record
# therefore remains in Vercel's zone — full independence would mean migrating
# that entire zone, which is a separate decision involving company email.
#
# Idempotent. Excluded from the image by .dockerignore.

set -euo pipefail

PROJECT_ID=vanna-main
ENV="${ENV:-dev}"
TTL=60

case "$ENV" in
  dev)  HOSTNAME_FQDN=test.stellar.vanna.finance; ZONE_NAME=test-stellar-vanna; LB_NAME=vanna-dev-ip  ;;
  prod) HOSTNAME_FQDN=app.stellar.vanna.finance;  ZONE_NAME=app-stellar-vanna;  LB_NAME=vanna-prod-ip ;;
  *) echo "ENV must be dev or prod" >&2; exit 1 ;;
esac

say() { printf '\n=== %s ===\n' "$1"; }

gcloud config set project "$PROJECT_ID" >/dev/null
gcloud services enable dns.googleapis.com

say "1/3 Load balancer address"
if ! gcloud compute addresses describe "$LB_NAME" --global >/dev/null 2>&1; then
  echo "  $LB_NAME does not exist yet — run infra/cdn.sh for ENV=$ENV first." >&2
  exit 1
fi
LB_IP=$(gcloud compute addresses describe "$LB_NAME" --global --format='value(address)')
echo "  $LB_NAME -> $LB_IP"

say "2/3 Managed zone for ${HOSTNAME_FQDN}"
# The zone apex IS the hostname, so a plain A record at the apex is all this
# zone ever needs — no CNAME-at-apex problem, nothing else lives under it.
gcloud dns managed-zones describe "$ZONE_NAME" >/dev/null 2>&1 || \
  gcloud dns managed-zones create "$ZONE_NAME" \
    --dns-name="${HOSTNAME_FQDN}." \
    --description="Delegated from the Vercel-hosted vanna.finance zone" \
    --visibility=public

# Remove-then-create rather than a guard, so a re-run is authoritative over any
# drift instead of silently leaving a stale address in place.
gcloud dns record-sets delete "${HOSTNAME_FQDN}." \
  --zone="$ZONE_NAME" --type=A >/dev/null 2>&1 || true
gcloud dns record-sets create "${HOSTNAME_FQDN}." \
  --zone="$ZONE_NAME" --type=A --ttl="$TTL" --rrdatas="$LB_IP" >/dev/null
echo "  A  ${HOSTNAME_FQDN}  ->  $LB_IP"

say "3/3 Delegation"
NS=$(gcloud dns managed-zones describe "$ZONE_NAME" --format='value(nameServers)' | tr ';' '\n' | tr -d ' ')
SUBDOMAIN="${HOSTNAME_FQDN%.vanna.finance}"

cat <<EOF
Cloud DNS is authoritative for ${HOSTNAME_FQDN} — but nothing uses it yet.

In the VERCEL dashboard, on the vanna.finance zone, DELETE the existing
A record for "${SUBDOMAIN}" and add these NS records in its place:

$(echo "$NS" | sed "s|^|  NS   ${SUBDOMAIN}   |")

Only ${HOSTNAME_FQDN} moves. stellar.vanna.finance and every other
subdomain keep answering from Vercel exactly as they do now.

Verify (expect the Google nameservers, not Vercel):

  dig +short NS ${HOSTNAME_FQDN}
  dig +short ${HOSTNAME_FQDN}          # expect ${LB_IP}

Reversible: delete the NS records and control returns to Vercel immediately.

One thread stays attached to Vercel by design — the NS record above lives in
their zone. Removing that too would mean migrating all of vanna.finance,
which carries the company MX record and nine other projects.
EOF
