import { expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { FirestoreRecordStore } from "@/lib/copilot/workflow/store";

const token = process.env.COPILOT_STORE_LIVE_TOKEN;
it.skipIf(!token)("persists encrypted records and enforces CAS in the selected Firestore database", async () => {
  const id = randomUUID();
  const store = new FirestoreRecordStore<{ state: string }>("vanna-mcp", "copilot-workflows", randomBytes(32).toString("hex"), async () => token!);
  try {
    expect(await store.write(id, null, { state: "synthetic-proposed" })).toBe(true);
    const initial = await store.read(id);
    expect(initial?.value.state).toBe("synthetic-proposed");
    const claims = await Promise.all(Array.from({ length: 3 }, () => store.write(id, initial!.version, { state: "synthetic-approved" })));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await store.read(id))?.value.state).toBe("synthetic-approved");
  } finally {
    const response = await fetch(`https://firestore.googleapis.com/v1/projects/vanna-mcp/databases/copilot-workflows/documents/copilot_workflows/${id}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
    });
    expect(response.ok).toBe(true);
  }
}, 60_000);
