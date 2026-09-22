---
name: deploy-mcp-services
description: Check what is actually deployed and, only if it is stale, manually deploy the MCP server and Sign Service to GCP. Use after reviewing or merging MCP-side work, after any change to vanna_mcp, before live-testing anything that depends on a server change, or whenever asked to deploy. Always verify first — another agent may already have deployed, and redeploying identical code wastes ten minutes.
---

# Deploying the MCP services

Automated deploys do not work on this repo and are not worth fixing right now. **Deploy
manually, but verify before you do** — someone else may already have shipped it.

Both automated paths are broken, for different reasons, and both fail silently:

- **GitHub Actions** `.github/workflows/deploy.yml` — wants
  `credentials_json: ${{ secrets.GCP_SA_KEY }}`; the repo has **no secrets configured**.
  Fails at auth on every push to `main`.
- **A Cloud Build trigger** running `cloudbuild.yaml` — the compute service account
  `29136047630-compute@…` lacks `run.services.get`. Fails at the deploy step.

Expect a red run after any push to `main`. It is not a new problem; do not chase it.

## Step 1 — Verify before deploying

Always. Redeploying identical code costs ten minutes and proves nothing.

```bash
gcloud run services list --project vanna-mcp \
  --format="table(metadata.name,status.latestReadyRevisionName,status.conditions[0].status,status.conditions[0].lastTransitionTime)"
```

Then decide honestly:

- **Deployed after the last relevant commit, and `STATUS` is True** → nothing to do. Say
  which revision is live and move on.
- **Deployed before the change** → deploy.
- **Unsure what the running image contains** → deploy. Ambiguity about what is in
  production is worth ten minutes.

**Check whether another agent already deployed.** Grok deploys too. The revision timestamp
against your commit time answers it — do not assume, and do not redeploy "to be safe".

## Step 2 — Deploy from each service's own directory

The path matters. `.gcloudignore` lives inside each service directory, so building from the
parent includes `node_modules` and the upload dies on Windows `MAX_PATH`.

```bash
# MCP server
cd /c/Users/akgam/Documents/vanna_mcp/vanna-mcp
gcloud run deploy vanna-mcp-server --source . --region us-central1 --project vanna-mcp --quiet

# Sign Service
cd /c/Users/akgam/Documents/vanna_mcp/vanna-mcp/sign-service
gcloud run deploy vanna-sign-service --source . --region us-central1 --project vanna-mcp --quiet
```

Deploy as `aditya@vanna.finance`, not the Cloud Build SA. `gcloud auth list` if a
permission error appears; `gh auth switch --user AdityaVanna` if git operations fail too.

**Never deploy contracts.** MCP and Sign Service only.

### Check the build context first

```bash
cd /c/Users/akgam/Documents/vanna_mcp && git status --short
```

`--source` uploads the **working tree**, not the commit. Uncommitted work ships with the
image — an MCP image once shipped in-flight edits to `risk_engine.py` and `sign_tools.py`
purely because they sat in the tree. If there is unrelated work, commit it deliberately or
stash it. If it belongs to another agent, deploy from a clean checkout of `main` instead.

## Step 3 — When a deploy fails

Cloud Run `--source` builds are **regional**. The default build list will not show them:

```bash
gcloud builds list --project vanna-mcp --region us-central1 --limit 3 \
  --format="value(id,status,createTime)"
gcloud builds log <ID> --project vanna-mcp --region us-central1 2>&1 | grep -iE "error|failed" | head
```

Common causes, in the order they actually occur:

| Symptom | Cause | Fix |
|---|---|---|
| `npm error ECONNRESET`, `network aborted` | Transient npm failure inside the build | **Retry.** Nothing is wrong. Seen once today; the retry succeeded. |
| `PERMISSION_DENIED: run.services.get` | The build ran as the compute SA | You ran `cloudbuild.yaml`, not `--source`. Use the commands above. |
| Upload hangs or dies on long paths | Built from the parent directory | Deploy from the service's own directory. |

**A failed deploy does not affect production** — the previous revision keeps serving 100%
of traffic. Say so when reporting a failure, so nobody panics.

## Step 4 — Verify it actually landed

```bash
gcloud run services list --project vanna-mcp \
  --format="table(metadata.name,status.latestReadyRevisionName)"
```

A `403` from `vanna-sign-service` is correct — it is IAM-gated. `401` from the MCP server
is correct — it is authenticated. Neither means the deploy failed.

Then exercise the change through the live path, not the local one, and record it in
`docs/copilot/PROMPT-LIBRARY.md`. A local pass proves nothing about production.

## Rollback

```bash
gcloud run services update-traffic <service> \
  --to-revisions <previous-revision>=100 --region us-central1 --project vanna-mcp
```

Get the previous revision from `gcloud run revisions list --service <service>`.

## Reporting

State the revision and whether you deployed or skipped:

```
vanna-mcp-server   00090-v5g  deployed from main @ 60b2717
vanna-sign-service 00048-vck  deployed (retried once — transient npm ECONNRESET)
vanna-connect-gateway 00011-mwr  unchanged, no change needed
```

"Deployed" and "already current, verified" are both good outcomes. Redeploying because you
did not check is not.
