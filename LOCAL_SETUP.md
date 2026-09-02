# Local setup — `copilot-assistant`

## 1. Clone and install

```
git clone https://github.com/vannafinance/mercury-stellar-backend.git
cd mercury-stellar-backend
git checkout copilot-assistant
npm install
```

## 2. Create `.env.local`

`.gitignore` matches `.env*`, so no env file is committed — but `.env.example` **is** in
the repo now, with every variable documented. Copy it and fill in the secrets:

```
cp .env.example .env.local
```

Ask Aditya for the five real values:

| Variable | What it is |
| --- | --- |
| `WORKOS_M2M_CLIENT_ID` | WorkOS machine-to-machine client, for MCP |
| `WORKOS_M2M_CLIENT_SECRET` | its secret |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Vertex service-account key (base64) — see §3 |
| `NEXT_PUBLIC_PRIVY_APP_ID` | Vanna embedded wallet. Public, ships to the browser. Without it the "Vanna wallet" login is hidden and only Freighter connects |
| `MCP_BASE_URL` | already defaulted to `https://mcp.vanna.finance/mcp` |

## 3. Vertex auth — nobody runs `gcloud auth login`, ever

**First, the thing that is easy to get wrong: no end user authenticates with Google.**
Vertex is called server-side, on behalf of the project. Visitors to the app never see
Google, never log into it, and are not affected by any of this. The only question is which
credential *the server* presents — and neither you nor the CTO should be re-running a login
either.

**Why it matters beyond convenience.** The fallback was whatever `gcloud auth login` the
machine happened to have. When that token lapses the Vertex call throws, routing degrades
to keyword matching, and the reply becomes the generic *"I can help with market data
(prices, pool stats)…"* paragraph — which reads as a hardcoded answer, and is why the same
prompt was answered on one laptop and refused on another. There is also no `gcloud` binary
and no ADC file on Vercel, so a deploy could never route with the model at all.

Two permanent answers. The copilot picks whichever is configured, preferring the first:

| | Credential | Rotation | Use for |
| --- | --- | --- | --- |
| 1 | **Workload Identity Federation** — host OIDC token exchanged for an access token | **Nothing to rotate**, no key exists | Production on Vercel |
| 2 | **Service-account key** in `GOOGLE_SERVICE_ACCOUNT_JSON` | One long-lived secret | Local dev, and production if you would rather skip the pool setup |

Either way it is set **once**, per environment, and never touched again.

### 3a. Local development — the service-account key

Generate it once:

```bash
gcloud iam service-accounts create vanna-copilot --project vanna-mcp

gcloud projects add-iam-policy-binding vanna-mcp \
  --member=serviceAccount:vanna-copilot@vanna-mcp.iam.gserviceaccount.com \
  --role=roles/aiplatform.user

gcloud iam service-accounts keys create key.json \
  --iam-account=vanna-copilot@vanna-mcp.iam.gserviceaccount.com

base64 -w0 key.json        # macOS: base64 -i key.json
```

Paste the base64 output as `GOOGLE_SERVICE_ACCOUNT_JSON`. Raw JSON works too; base64 is
suggested because hosting dashboards mangle multi-line values. Then **delete `key.json`** —
it is a live credential.

Hand the same base64 to anyone else who works on this. That is the whole onboarding step,
and it replaces `gcloud auth login` permanently.

Check it took: the copilot page header shows an amber **`gcloud login`** chip whenever no
real credential is configured, i.e. whenever the app is leaning on a developer login that
will expire. No chip means a project credential is in use.

### 3b. Production — Workload Identity Federation (keyless)

Preferred for the deployed app: there is no private key anywhere, so there is nothing to
leak, nothing to rotate, and nothing to re-paste when someone leaves. Vercel mints a short
OIDC token per deployment proving which project is running; Google's Security Token Service
trades it for an access token.

One-time GCP setup (replace the team slug with yours):

```bash
PROJECT_NUM=$(gcloud projects describe vanna-mcp --format='value(projectNumber)')

gcloud iam workload-identity-pools create vercel \
  --project vanna-mcp --location global --display-name "Vercel"

gcloud iam workload-identity-pools providers create-oidc vercel-oidc \
  --project vanna-mcp --location global --workload-identity-pool vercel \
  --issuer-uri "https://oidc.vercel.com/<vercel-team-slug>" \
  --allowed-audiences "https://vercel.com/<vercel-team-slug>" \
  --attribute-mapping "google.subject=assertion.sub"

gcloud iam service-accounts add-iam-policy-binding \
  vanna-copilot@vanna-mcp.iam.gserviceaccount.com --project vanna-mcp \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/$PROJECT_NUM/locations/global/workloadIdentityPools/vercel/*"
```

Then enable OIDC in **Vercel → Project Settings → Security**, and set two variables on the
production environment only:

```
GOOGLE_WORKLOAD_IDENTITY_AUDIENCE=//iam.googleapis.com/projects/<PROJECT_NUM>/locations/global/workloadIdentityPools/vercel/providers/vercel-oidc
GOOGLE_WORKLOAD_IDENTITY_SERVICE_ACCOUNT=vanna-copilot@vanna-mcp.iam.gserviceaccount.com
```

You can then **remove `GOOGLE_SERVICE_ACCOUNT_JSON` from production** and keep it only in
local `.env.local`. Federation wins when both are set, so it is safe to add first and
delete the key afterwards.

Tighten the `--attribute-mapping` / add an `--attribute-condition` if you want only certain
deployments to be able to mint tokens; the mapping above accepts any deployment in the team.

> Not on Vercel? If the app ever moves to **Cloud Run**, none of §3b is needed — attach the
> service account to the service and the metadata server provides the token automatically
> via ADC, which is already in the chain. `GOOGLE_OIDC_TOKEN_ENV` lets the federation path
> read the OIDC token from a different variable for other hosts (GitHub Actions, Netlify).

<details>
<summary>Fallback if you have not got the key yet</summary>

```
gcloud auth login
```

with an account that has Vertex AI access on `vanna-mcp`. Plain user login is enough — you
do **not** need `gcloud auth application-default login`, which fails with `invalid_rapt`
on some accounts. Re-run it whenever the copilot says it cannot reach the model.

</details>

## 4. Run

```
npm run dev
```

Open `http://localhost:3000/copilot`. Connect a Freighter or Privy wallet and try a
read-only prompt first — `price of XLM`, or `show my positions` — before anything that
writes.

## 5. Deploying (Vercel)

Every push auto-deploys a preview. Set these in **Project → Settings → Environment
Variables** first, or the preview builds but the copilot cannot reach anything:

| Variable | Notes |
| --- | --- |
| `GOOGLE_WORKLOAD_IDENTITY_AUDIENCE` + `..._SERVICE_ACCOUNT` | runtime — **or** the key below; see §3b |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | runtime — needed unless §3b is set up |
| `WORKOS_M2M_CLIENT_ID` | runtime |
| `WORKOS_M2M_CLIENT_SECRET` | runtime |
| `WORKOS_M2M_TOKEN_URL` | runtime |
| `MCP_BASE_URL` | runtime |
| `MCP_MODE=live` | runtime |
| `GOOGLE_CLOUD_PROJECT=vanna-mcp` | runtime |
| `GOOGLE_CLOUD_LOCATION=global` | runtime |
| `VERTEX_MODEL=gemini-3.6-flash` | runtime |
| `NEXT_PUBLIC_PRIVY_APP_ID` | **build time** — `NEXT_PUBLIC_*` is inlined during the build, so set it *before* the deploy or redeploy after adding it |

## Auto-sign: what works today, and what unblocks the rest

### Working now — Privy embedded wallets

This is the wallet the product ships, so it is the path that matters. With auto-approve on,
`lib/wallet-adapter.ts::signTransaction` signs through the Privy bridge
(`bridge.signRawHash`) and submits, with **no wallet popup in the app's path**. This is
entirely client-side and does not involve the Sign Service, which is why it works while the
Sign Service does not.

**Freighter cannot auto-approve, and never will client-side** — `signTransaction` falls
through to `FreighterApi.signTransaction`, and the extension always shows its own popup by
design. The toggle now says so on click instead of being an inert control. (This is why it
looked broken for the CTO: his screenshots show `SIGNER freighter`.)

### Not working — the MCP Sign Service

Server-side auto-sign, and with it server-enforced spend caps, returns
`401 invalid_user_assertion` / *"Invalid token audience"* on **every** enable call. Verified
against the live server: step 1 (the cap options) returns 200, then both `use_default_caps`
and explicit caps fail. Root cause is in `vanna_mcp`: the MCP verifies the caller's bearer
against a *set* of audiences (`OAUTH_AUDIENCE` + `OAUTH_M2M_AUDIENCE`) and forwards it, while
the Sign Service verified against a *single* value — two hops that could not be configured
to agree. Full write-up, evidence and options: `AUTOSIGN_AUDIENCE_BLOCKER.md` in `vanna_mcp`.

Because it is off, the copilot does not pretend otherwise: the Autonomy card shows a
`sign service: unavailable (Invalid token audience)` row and labels the caps as this
browser's own limit rather than enforced policy.

### Deploy order, when you fix it

1. **Only the Sign Service needs deploying.** The fix is in `sign-service/`; `mcp_server/`
   is untouched, so the MCP does not need redeploying.
2. Set `WORKOS_AUDIENCE` on the Sign Service to include every audience the MCP accepts —
   its `OAUTH_AUDIENCE` plus each `OAUTH_M2M_AUDIENCE` entry, comma-separated. The code
   change alone does nothing; this value is the actual switch.
3. **The app needs no redeploy and no change.** It already handles both outcomes and will
   report `sign service: session registered` once the call succeeds.
4. **Read `AUTOSIGN_AUDIENCE_BLOCKER.md` §4b before step 2.** An M2M token's `sub` is the
   machine (identical for every user), so accepting it as a user assertion makes
   `session.userId` and `isBound()` the same for everybody — the impersonation hole the
   assertion was added to close. Decide that first; it is not a config tweak.
