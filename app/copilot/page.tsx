import type { Metadata } from "next";
import { CopilotWorkspace } from "@/components/copilot/copilot-workspace";

export const metadata: Metadata = {
  title: "Copilot · Vanna",
};

export default function CopilotPage() {
  return <CopilotWorkspace />;
}
