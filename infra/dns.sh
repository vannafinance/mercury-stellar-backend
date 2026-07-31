#!/usr/bin/env bash
# Delegate stellar.vanna.finance to Google Cloud DNS.
#
# Only the stellar subtree moves. The parent vanna.finance zone stays where it
# is, which matters because it carries the Google Workspace MX record
# (1 smtp.google.com) and the google-site-verification TXT. Recreating those by
# hand during a migration is how companies lose email, and none of it is needed
# to get Stellar onto GCP.
#
#   bash infra/dns.sh
#
# Run this AFTER the load balancer is proven working via a plain A record in
# Vercel. Delegating first means a failure could be either the LB or the
# delegation, with no way to tell which.
#
# Idempotent. Excluded from the image by .dockerignore.

set -euo pipefail

PROJECT_ID=vanna-main
ZONE_NAME=stellar-vanna
DNS_NAME=stellar.vanna.finance
TTL=300

# Records that must exist in the new zone the moment delegation takes effect.
# Anything under stellar.vanna.finance that is NOT listed here stops resolving
# as soon as Vercel hands the subtree over — delegation moves the whole subtree,
# not just the names we care about.
#
# Current Vercel targets, preserved so nothing breaks on cutover. Re-check these
# before running; they are Vercel anycast addresses and can change.
APEX_A="216.150.1.1 216.150.16.129"        # stellar.vanna.finance  — still Vercel
PROD_A="216.150.1.129 216.150.1.1"         # app.stellar…           — still Vercel

# Already migrated to the GCP load balancer.
DEV_A="8.232.192.197"                      # test.stellar…          — GCP

say() { printf '\n=== %s ===\n' "$1"; }

gcloud config set project "$PROJECT_ID" >/dev/null
gcloud services enable dns.googleapis.com

say "1/3 Managed zone for ${DNS_NAME}"
gcloud dns managed-zones describe "$ZONE_NAME" >/dev/null 2>&1 || \
  gcloud dns managed-zones create "$ZONE_NAME" \
    --dns-name="${DNS_NAME}." \
    --description="Stellar subtree, delegated from the Vercel-hosted parent zone" \
    --visibility=public

say "2/3 Records"
# add-record-set fails if the name already exists, so remove then add rather
# than guarding — that keeps a re-run authoritative over drift.
put_a() {
  local name="$1"; shift
  local values="$*"
  gcloud dns record-sets delete "$name" --zone="$ZONE_NAME" --type=A >/dev/null 2>&1 || true
  # shellcheck disable=SC2086
  gcloud dns record-sets create "$name" \
    --zone="$ZONE_NAME" --type=A --ttl="$TTL" \
    --rrdatas="$(echo $values | tr ' ' ',')" >/dev/null
  echo "  A  $name  ->  $values"
}

put_a "${DNS_NAME}."               $APEX_A
put_a "test.${DNS_NAME}."          $DEV_A
put_a "app.${DNS_NAME}."           $PROD_A

say "3/3 Delegation"
NS=$(gcloud dns managed-zones describe "$ZONE_NAME" \
      --format='value(nameServers)' | tr ';' '\n' | tr -d ' ')

cat <<EOF
Cloud DNS is now authoritative for ${DNS_NAME} — but nothing uses it yet.

Add these NS records in the VERCEL dashboard, on the vanna.finance zone,
for the name "stellar":

$(echo "$NS" | sed 's/^/  NS   stellar   /')

Until those exist, Vercel keeps answering for the subtree and this zone is
inert. That makes the cutover reversible: delete the NS records and control
returns to Vercel immediately.

Verify delegation took effect (expect the Google nameservers, not Vercel):

  dig +short NS ${DNS_NAME}

Then confirm the records still resolve correctly:

  dig +short test.${DNS_NAME}    # expect ${DEV_A}
  dig +short app.${DNS_NAME}     # expect ${PROD_A}
  dig +short ${DNS_NAME}         # expect ${APEX_A}

Email is unaffected: the MX record lives on vanna.finance, which is not
delegated and is not touched by this script.
EOF
