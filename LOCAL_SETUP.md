# Local setup — `copilot-assistant` branch

## 1. Clone and install

```
git clone https://github.com/vannafinance/mercury-stellar-backend.git
cd mercury-stellar-backend
git checkout copilot-assistant
npm install
```

## 2. Create `.env.local`

There is **no `.env.example` in the repo** — `.gitignore` matches `.env*`, so it never
got committed. Create `.env.local` in the project root yourself with the block below,
then ask Aditya for the four blank values (WorkOS client ID/secret, Privy app ID —
all live credentials, not placeholders).

```bash
# ---- Copilot (in-process — runs inside Next.js, no separate server) ----
LLM_PROVIDER=vertex
GOOGLE_CLOUD_PROJECT=vanna-mcp
GOOGLE_CLOUD_LOCATION=global
VERTEX_MODEL=gemini-3.6-flash

MCP_MODE=live
MCP_BASE_URL=https://mcp.vanna.finance/mcp

# WorkOS machine-to-machine auth for MCP — ask Aditya for these three
WORKOS_M2M_CLIENT_ID=
WORKOS_M2M_CLIENT_SECRET=
WORKOS_M2M_TOKEN_URL=https://sensitive-silk-47-staging.authkit.app/oauth2/token

# Vanna embedded wallet (Privy). Public app ID, ships to the browser — ask Aditya.
# Without it, "Vanna wallet" login is hidden and only Freighter works.
NEXT_PUBLIC_PRIVY_APP_ID=
```

## 3. Google Cloud auth (for Vertex/Gemini)

```
gcloud auth login
```

Log in with the account that has Vertex AI access on project `vanna-mcp`. You do
**not** need `gcloud auth application-default login` — plain user login is enough,
and application-default login on some accounts fails with `invalid_rapt`.

Re-run `gcloud auth login` any time the copilot replies *"I cannot reach the AI
model right now"* — that error means the login token has expired.

## 4. Run

```
npm run dev
```

Open `http://localhost:3000/copilot`. Connect a Freighter or Privy wallet and try a
prompt — e.g. `price of XLM` (read-only, no signature) before anything that writes.

