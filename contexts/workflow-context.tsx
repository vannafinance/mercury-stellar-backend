"use client";

import { createContext, useContext } from "react";
import { useWorkflow } from "@/hooks/use-workflow";
import { useUserStore } from "@/store/user";

/**
 * Persists workflow execution and ledger polling across page navigation.
 *
 * Like `InvestigationProvider`, mounting this in the root layout provider stack ensures
 * that an in-flight workflow (awaiting approval, signing, or polling Soroban ledger confirmations)
 * is not aborted when the user navigates from /copilot to /margin or /portfolio.
 * Returning to /copilot reads back the identical live execution state.
 */
type Workflow = ReturnType<typeof useWorkflow>;

const WorkflowContext = createContext<Workflow | null>(null);

export function WorkflowProvider({ children }: { children: React.ReactNode }) {
  const address = useUserStore((s) => s.address);
  const workflow = useWorkflow(address);
  return (
    <WorkflowContext.Provider value={workflow}>
      {children}
    </WorkflowContext.Provider>
  );
}

export function useLiveWorkflow(): Workflow {
  const value = useContext(WorkflowContext);
  if (!value) {
    throw new Error("useLiveWorkflow must be used inside <WorkflowProvider>");
  }
  return value;
}
