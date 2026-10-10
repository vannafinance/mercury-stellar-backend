import { Account, Keypair, Networks, Operation, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRecord } from "@/lib/copilot/workflow/types";
import type { RecordStore } from "@/lib/copilot/workflow/store";
const h = vi.hoisted(() => {
  const rows = new Map<string, { value: WorkflowRecord; version: string }>();
  const store: RecordStore<WorkflowRecord> = {
    read: async id => structuredClone(rows.get(id) ?? null),
    write: async (id, version, value) => {
      if ((rows.get(id)?.version ?? null) !== version) return false;
      rows.set(id, { version: String(Number(version ?? -1) + 1), value: structuredClone(value) }); return true;
    },
  };
  return { rows, store, scope: vi.fn(), fee: vi.fn(), refresh: vi.fn() };
});
vi.mock("@/lib/copilot/workflow/store", async original => ({ ...await original<typeof import("@/lib/copilot/workflow/store")>(), workflowStore: () => h.store }));
vi.mock("@/lib/copilot/investigation/scope", async original => ({ ...await original<typeof import("@/lib/copilot/investigation/scope")>(), resolveInvestigationScope: h.scope }));
vi.mock("@/lib/copilot/workflow/risk", () => ({ validateWorkflowRisk: async () => null }));
vi.mock("@/lib/copilot/workflow/fee-budget", () => ({ checkTransactionFee: h.fee }));
vi.mock("@/lib/copilot/workflow/signing-envelope", async original => ({ ...await original<typeof import("@/lib/copilot/workflow/signing-envelope")>(), refreshSigningEnvelope: h.refresh, checkSigningPreconditions: async () => {} }));
import { WorkflowJournal } from "@/lib/copilot/workflow/journal";
import { advanceWorkflow, prepareWorkflowSigning, submitWorkflow } from "@/lib/copilot/investigation/execute";
const wallet = Keypair.random();
const scope = { subject: "owner", trader: wallet.publicKey(), smartAccount: StrKey.encodeContract(Buffer.alloc(32, 2)), network: "testnet" };
const identity = { scope, server: "https://mcp.test" };
const reserves = [{ asset: "XLM", amount: "100" }];
const tx = () => new TransactionBuilder(new Account(wallet.publicKey(), "1"), { fee: "100", networkPassphrase: Networks.TESTNET })
  .addOperation(Operation.invokeContractFunction({ contract: scope.smartAccount, function: "deposit", args: [] })).setTimeout(300).build();
beforeEach(() => { h.rows.clear(); h.scope.mockResolvedValue(scope); h.fee.mockReset().mockResolvedValue(undefined); h.refresh.mockReset().mockImplementation(async xdr => xdr); });
async function fixture(waiting = true) {
  const journal = new WorkflowJournal(h.store);
  const record = await journal.create({ ...identity, objective: "Deposit", messages: [], assumptions: [], constraints: [], floor: null, walletReserves: reserves,
    steps: [{ id: "one", op: "deposit_collateral", asset: "XLM", amount: "5", label: "Deposit", tool: "vanna_deposit_collateral",
      args: { amount: "5", symbol: "XLM", trader: scope.trader, smart_account: scope.smartAccount } }] });
  const id = record.proposal.id; const envelope = tx();
  await journal.approve(id, identity, 1, record.proposal.digest, async () => null);
  if (waiting) { await journal.claimNext(id, identity); await journal.invocationResult(id, identity, "one", { kind: "unsigned", unsignedXdr: envelope.toXDR() }); }
  const input = { id, subject: scope.subject, secret: "reserve-fixture-secret-of-at-least-32-characters", server: identity.server, network: scope.network,
    signal: new AbortController().signal, mcp: { call: vi.fn(async () => ({ enabled: false })) } };
  return { journal, record, id, envelope, input };
}
describe("sealed wallet reserve across execution", () => {
  it("checks the sealed floor before opening the wallet and leaves approval and envelope intact on refusal", async () => {
    const f = await fixture(); h.fee.mockRejectedValue(new Error("reserve fee shortfall"));
    await expect(prepareWorkflowSigning(f.input)).rejects.toThrow("reserve fee shortfall");
    expect(h.fee).toHaveBeenCalledWith(f.envelope.toXDR(), f.record.proposal.steps[0], fetch, reserves);
    const row = (await f.journal.read(f.id, identity)).value;
    expect(row.proposal).toEqual(f.record.proposal); expect(row.status).toBe("awaiting_signature");
    expect(row.steps[0].unsignedXdr).toBe(f.envelope.toXDR()); expect(f.input.mcp.call).not.toHaveBeenCalled();
  });
  it("rechecks the same floor after a signed wallet popup and never broadcasts a refused signature", async () => {
    const f = await fixture(); f.envelope.sign(wallet); h.fee.mockRejectedValue(new Error("reserve fee shortfall"));
    const sendTx = vi.fn();
    await expect(submitWorkflow({ ...f.input, signedXdr: f.envelope.toXDR(), sendTx })).rejects.toThrow("reserve fee shortfall");
    expect(h.fee).toHaveBeenCalledWith(f.envelope.toXDR(), f.record.proposal.steps[0], fetch, reserves);
    expect(sendTx).not.toHaveBeenCalled(); expect((await f.journal.read(f.id, identity)).value.steps[0].txHash).toBeUndefined();
  });
  it.each([{ enabled: true }, {}, { enabled: false, error: "unavailable" }])("refuses a delegated or unverifiable signer before the MCP write: %j", async status => {
    const f = await fixture(false); const call = vi.fn(async () => status);
    const view = await advanceWorkflow({ ...f.input, mcp: { call }, ready: async () => ({ kind: "ready" }), lookupTx: async () => ({ found: false }) });
    expect(view.status).toBe("blocked"); expect(view.message).toContain("Nothing was submitted");
    expect(call.mock.calls).toEqual([["vanna_auto_sign_status", { wallet_address: scope.trader }, scope.trader]]);
  });
});
