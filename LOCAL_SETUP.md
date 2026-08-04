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

## 3. Vertex auth — one variable, no `gcloud` needed

Set `GOOGLE_SERVICE_ACCOUNT_JSON` and you are done. It is the same value locally and in
every deploy, it belongs to the project rather than to a person, and it does not expire.

**Why this matters, and not just as convenience.** The copilot's fallback was this
machine's `gcloud auth login`. When that token lapses the Vertex call throws, routing
degrades to keyword matching, and the reply becomes the generic *"I can help with market
data (prices, pool stats)…"* paragraph. It looks like a hardcoded answer, and it is why
the same prompt was answered on one laptop and refused on another. There is also no
`gcloud` binary and no ADC file on Vercel, so a deploy could never route with the model
at all. One service account removes both problems.

Generate the key once:

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

Check it took: the copilot page header shows an amber **`gcloud login`** chip whenever the
variable is unset, i.e. whenever the app is leaning on a developer login that will expire.
No chip means the service account is in use.

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
| `GOOGLE_SERVICE_ACCOUNT_JSON` | runtime |
| `WORKOS_M2M_CLIENT_ID` | runtime |
| `WORKOS_M2M_CLIENT_SECRET` | runtime |
| `WORKOS_M2M_TOKEN_URL` | runtime |
| `MCP_BASE_URL` | runtime |
| `MCP_MODE=live` | runtime |
| `GOOGLE_CLOUD_PROJECT=vanna-mcp` | runtime |
| `GOOGLE_CLOUD_LOCATION=global` | runtime |
| `VERTEX_MODEL=gemini-3.6-flash` | runtime |
| `NEXT_PUBLIC_PRIVY_APP_ID` | **build time** — `NEXT_PUBLIC_*` is inlined during the build, so set it *before* the deploy or redeploy after adding it |

## Known limitation: MCP auto-sign

Enabling auto-sign returns `401 invalid_user_assertion` / *"Invalid token audience"* from
the MCP Sign Service. Verified against the live server: step 1 (the cap options) succeeds,
the enable call always fails. Our WorkOS M2M token carries an audience the Sign Service
does not accept, so this is a server-side config fix, not a frontend one.

What still works: in-app auto-approve for Vanna embedded (Privy) wallets, where the
browser signs a staged transaction without a prompt. The spend caps are that browser's own
limit, not enforced policy — the copilot's Autonomy card states this, and shows a
`sign service: unavailable` row rather than claiming caps are being enforced. Freighter
cannot auto-approve at all; it always signs in its own extension popup.
