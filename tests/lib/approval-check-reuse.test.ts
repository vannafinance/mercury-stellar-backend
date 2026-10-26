import { beforeEach, describe, expect, it, vi } from "vitest";

const risk = vi.hoisted(() => ({ validateWorkflowRisk: vi.fn(async (): Promise<string | null> => null) }));
vi.mock("@/lib/copilot/workflow/risk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/copilot/workflow/risk")>()),
  validateWorkflowRisk: risk.validateWorkflowRisk,
}));
vi.mock("@/lib/copilot/mcp-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/copilot/mcp-client")>()),
  getMcpClient: () => ({ call: vi.fn() }),
}));

import { APPROVAL_CHECK_FRESH_MS, readyForStep } from "@/lib/copilot/investigation/execute";
import type { ProposalStep, WorkflowProposal } from "@/lib/copilot/workflow/types";

const step = (id: string) => ({ id } as unknown as ProposalStep);
const proposal = { id: "wf-1", digest: "d", steps: [step("s1"), step("s2")] } as unknown as WorkflowProposal;
const T0 = 1_000_000;

beforeEach(() => { risk.validateWorkflowRisk.mockReset(); risk.validateWorkflowRisk.mockResolvedValue(null); });

describe("advance relies on Approve's check once, for the first step only", () => {
  it("skips the repeat check for the first step claimed right after Approve passed", async () => {
    const out = await readyForStep(proposal, proposal.steps[0], { index: 0, approvedAt: T0 }, T0 + 1_500);
    expect(out).toEqual({ kind: "ready" });
    expect(risk.validateWorkflowRisk).not.toHaveBeenCalled();
  });

  it("a later step is always checked, however recent the approval", async () => {
    await readyForStep(proposal, proposal.steps[1], { index: 1, approvedAt: T0 }, T0 + 500);
    expect(risk.validateWorkflowRisk).toHaveBeenCalledTimes(1);
  });

  it("an approval older than the window is not relied on", async () => {
    await readyForStep(proposal, proposal.steps[0], { index: 0, approvedAt: T0 }, T0 + APPROVAL_CHECK_FRESH_MS + 1);
    expect(risk.validateWorkflowRisk).toHaveBeenCalledTimes(1);
  });

  it("no approval stamp, or no claim context, means the check runs as before", async () => {
    await readyForStep(proposal, proposal.steps[0], { index: 0 }, T0);
    await readyForStep(proposal, proposal.steps[0]);
    expect(risk.validateWorkflowRisk).toHaveBeenCalledTimes(2);
  });

  it("a stamp from the future is not trusted", async () => {
    await readyForStep(proposal, proposal.steps[0], { index: 0, approvedAt: T0 + 60_000 }, T0);
    expect(risk.validateWorkflowRisk).toHaveBeenCalledTimes(1);
  });

  it("a failing repeat check still stops the step", async () => {
    risk.validateWorkflowRisk.mockResolvedValueOnce("The contract-valued position is already below your health-factor floor.");
    expect(await readyForStep(proposal, proposal.steps[0], { index: 0, approvedAt: T0 }, T0 + APPROVAL_CHECK_FRESH_MS + 5_000))
      .toMatchObject({ kind: "stop", reason: expect.stringContaining("below your health-factor floor") });
  });
});
