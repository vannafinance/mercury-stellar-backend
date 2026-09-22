# Copilot workflow store

The selected Google project is `vanna-mcp` (user confirmed 2026-09-09).
The Firestore API is enabled. The dedicated native database `copilot-workflows`
exists in `us-central1`, with deletion protection enabled.

Configure the server with:

```dotenv
COPILOT_WORKFLOW_FIRESTORE_PROJECT=vanna-mcp
COPILOT_WORKFLOW_FIRESTORE_DATABASE=copilot-workflows
```

These settings are independent of the Vertex/BigQuery project. They are included in
`cloudbuild.yaml` as overridable substitutions. No deployment was performed.

The adapter uses Application Default Credentials with the datastore scope. The runtime
identity needs database access in `vanna-mcp`; successful developer gcloud access does
not prove the Cloud Run service account has that access. Verify the deployed identity
before rollout. Do not copy a developer access token into application configuration.

The configured runtime account `vanna-app-run@vanna-main.iam.gserviceaccount.com`
has no project IAM binding in `vanna-mcp`. A proposed `roles/datastore.user` grant
is restricted to this database by `workflow-database-condition.json`, following
[Google's database access condition documentation](https://firebase.google.com/docs/firestore/manage-databases).
Automatic approval review rejected applying that persistent access change without
explicit user approval. No grant was applied. Database creation and the developer's
live storage test succeeded independently of this deployment permission gate.

Records are encrypted with AES-256-GCM and a purpose-separated key derived from the
server secret. Keep that secret stable across replicas and restarts. Losing or rotating
it without a migration makes previous records unreadable. No browser-supplied steps
or signing authority belong in an approval request.

Firestore create/update preconditions enforce compare-and-swap. Development can use
an encrypted append-only local journal if the Firestore project setting is absent.
Production and Cloud Run refuse the local fallback.

Verification completed on 2026-09-09:

- Four storage tests cover reopening persistence, encryption, concurrent independent
  store instances, stale versions, and Firestore precondition wiring.
- Five journal tests cover identity, expiration, modified approvals, concurrent
  approval/step claims, uncertain outcomes, failed validation, and matching settlement.
- The opt-in live Firestore test passed against this database: encrypted create/read,
  one winner among three concurrent claims, and test-record cleanup.

The journal is infrastructure, not the finished transaction executor. Proposal
compilation, per-leg financial validation, signed-envelope verification, recovery APIs,
and browser approval wiring must be completed before this path can execute funds.
An ambiguous MCP invocation must never be retried as a new transaction automatically.
