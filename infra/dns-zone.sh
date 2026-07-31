#!/usr/bin/env bash
# Build a Cloud DNS copy of the vanna.finance zone currently hosted at Vercel.
#
#   bash infra/dns-zone.sh
#
# NOTHING BREAKS WHEN YOU RUN THIS. The zone stays inert until someone changes
# the nameservers at the registrar — until then every lookup still goes to
# Vercel. That switch is the last step and belongs to whoever owns the domain.
#
# THE ZONE CARRIES COMPANY EMAIL. The MX record below routes all mail for
# @vanna.finance to Google Workspace. If the nameservers are switched before
# this zone is built and verified, mail stops being delivered — not bounced,
# just gone. Run the verification at the end and read its output before telling
# anyone to touch the registrar.
#
# Record set copied from `vercel dns ls vanna.finance` on 2026-07-31. Re-run
# that command before switching and diff it against this file: anything added
# to the Vercel zone in the meantime would silently disappear at cutover.
#
# Idempotent. Excluded from the image by .dockerignore.

set -euo pipefail

PROJECT_ID=vanna-main
ZONE_NAME=vanna-finance
DNS_NAME=vanna.finance
TTL=300

say() { printf '\n=== %s ===\n' "$1"; }

gcloud config set project "$PROJECT_ID" >/dev/null
gcloud services enable dns.googleapis.com

say "1/3 Managed zone for ${DNS_NAME}"
gcloud dns managed-zones describe "$ZONE_NAME" >/dev/null 2>&1 || \
  gcloud dns managed-zones create "$ZONE_NAME" \
    --dns-name="${DNS_NAME}." \
    --description="Copy of the Vercel-hosted zone, pending a registrar nameserver switch" \
    --visibility=public

# Remove-then-create so a re-run is authoritative rather than failing on
# "already exists" and leaving stale values behind.
put() {
  local name="$1" type="$2" rrdatas="$3"
  gcloud dns record-sets delete "$name" --zone="$ZONE_NAME" --type="$type" >/dev/null 2>&1 || true
  gcloud dns record-sets create "$name" \
    --zone="$ZONE_NAME" --type="$type" --ttl="$TTL" --rrdatas="$rrdatas" >/dev/null
  printf '  %-34s %-6s %s\n' "$name" "$type" "$rrdatas"
}

say "2/3 Records"

# --- mail. Wrong here means silent mail loss, so it goes first and alone. ---
put "${DNS_NAME}." MX "1 smtp.google.com."

# --- domain ownership proofs ---
put "${DNS_NAME}." TXT '"google-site-verification=gd1vj8j1ysl3R9YXwQKARsFJ9QjSDZ4esb2n7vA4MXI"'
put "61299357.${DNS_NAME}." CNAME "google.com."

# --- apex. Vercel served this as an ALIAS, which Cloud DNS does not have, and
# a CNAME is illegal at a zone apex. 76.76.21.21 is Vercel's documented apex
# address for exactly this case — it is what their own dashboard suggests when
# you are not using their nameservers. ---
put "${DNS_NAME}." A "76.76.21.21"

# --- wildcard: every subdomain without its own record (www, app, blog,
# dashboard, api, staging, cdn, mail) resolves through this. ALIAS -> CNAME is
# a straight swap here because it is not at the apex. ---
put "*.${DNS_NAME}." CNAME "cname.vercel-dns-016.com."

# --- stellar: a live site on the separate stellar-backend Vercel project ---
put "stellar.${DNS_NAME}." CNAME "cname.vercel-dns-016.com."

# --- the one record already pointing at GCP ---
put "test.stellar.${DNS_NAME}." A "8.232.192.197"

# --- docs, on Mintlify behind Cloudflare, plus its certificate validation ---
put "docs.${DNS_NAME}." CNAME "cname.mintlify.builders."
put "_cf-custom-hostname.docs.${DNS_NAME}." TXT '"50fa17f2-29b6-40e7-aaae-740acf106ba0"'
put "_acme-challenge.docs.${DNS_NAME}." TXT '"hTJ4f7_GWnd0MbTOo8eI-5CWnofpW8MfhDDYlgxSpgw"'

# --- google-hosted ---
put "mcp.${DNS_NAME}." CNAME "ghs.googlehosted.com."

# --- CAA: one record set, three values. These restrict which authorities may
# issue certificates. pki.goog must stay or Google-managed certificates for
# app.stellar stop provisioning. ---
put "${DNS_NAME}." CAA '0 issue "pki.goog",0 issue "sectigo.com",0 issue "letsencrypt.org"'

say "3/3 Verify BEFORE anyone touches the registrar"
NS1=$(gcloud dns managed-zones describe "$ZONE_NAME" --format='value(nameServers)' | tr ';' '\n' | tr -d ' ' | head -1)

cat <<EOF
Cloud DNS now holds a copy of the zone. Nothing uses it yet — every lookup on
the internet still goes to Vercel.

Query Google's nameserver directly and confirm each line matches what Vercel
serves today. dig asks $NS1 specifically, bypassing normal resolution:

  dig +short @$NS1 MX    ${DNS_NAME}      # 1 smtp.google.com.
  dig +short @$NS1 A     ${DNS_NAME}      # 76.76.21.21
  dig +short @$NS1       www.${DNS_NAME}  # cname.vercel-dns-016.com.
  dig +short @$NS1       docs.${DNS_NAME} # cname.mintlify.builders.
  dig +short @$NS1       app.${DNS_NAME}  # cname.vercel-dns-016.com.
  dig +short @$NS1       test.stellar.${DNS_NAME}   # 8.232.192.197
  dig +short @$NS1 TXT   ${DNS_NAME}      # google-site-verification=...
  dig +short @$NS1 CAA   ${DNS_NAME}      # three values incl. pki.goog

Compare against the live zone:

  npx vercel dns ls ${DNS_NAME} --scope vanna-group

Only once every line matches, ask whoever owns the domain to replace the
nameservers at the registrar with:

$(gcloud dns managed-zones describe "$ZONE_NAME" --format='value(nameServers)' | tr ';' '\n' | sed 's/^ *//' | sed 's/^/  /')

Then watch mail first — it is the thing that fails silently. Send a test
message to an @${DNS_NAME} address and confirm it arrives.

Rollback: put the Vercel nameservers back at the registrar. Propagation takes
as long as the old TTL, so lower TTLs a day beforehand if you want a fast exit.
EOF
