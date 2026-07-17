import type { Metadata } from "next";
import { CopilotWorkspace } from "@/components/copilot/copilot-workspace";

export const metadata: Metadata = {
  title: "Copilot",
  description:
    "State an intent in plain English — Vanna Copilot plans the on-chain steps, runs the deterministic risk gate, and waits for your approval before anything signs.",
};

export default function CopilotPage() {
  return <CopilotWorkspace />;
}
