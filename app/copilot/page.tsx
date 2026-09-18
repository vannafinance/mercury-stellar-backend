import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CopilotWorkspace } from "@/components/copilot/copilot-workspace";
import { isCopilotEnabled } from "@/lib/copilot/enabled";

export const metadata: Metadata = {
  title: "Copilot · Vanna",
};

export default function CopilotPage() {
  if (!isCopilotEnabled()) notFound();
  return <CopilotWorkspace />;
}
