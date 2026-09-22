"use client";

import { CircleAlert } from "lucide-react";
import type { ThreadTurn } from "@/lib/copilot/investigation/thread";
import type { ExecutionReceiptSnapshot } from "@/lib/copilot/execution-receipt";
import { ExecutionStepper, type StepperStep } from "@/components/copilot/execution-stepper";

/**
 * Live thread chrome: user on the right, copilot on the left.
 *
 * This is not sample data. Callers pass `investigation.turns` plus the in-flight
 * `/api/copilot` payload. Stored copilot turns sometimes append `• label: value`
 * lines; those stay in storage and are stripped here for display.
 */

export function UserBubble({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end" }}>
      <p
        style={{
          maxWidth: "82%",
          margin: 0,
          background: "var(--g50)",
          border: "1px solid var(--g100)",
          borderRadius: 14,
          padding: "9px 14px",
          fontSize: 14,
          lineHeight: "21px",
          color: "var(--g800)",
          textWrap: "pretty",
        }}
      >
        {children}
      </p>
    </div>
  );
}

export function AssistantMessage({
  children,
  note,
  tone = "default",
}: {
  children: React.ReactNode;
  note?: string | null;
  tone?: "default" | "error";
}) {
  return (
    <div>
      <p
        style={{
          margin: 0,
          fontSize: 16,
          lineHeight: "26px",
          color: tone === "error" ? "var(--z-danger, #c23d3d)" : "var(--g800)",
          textWrap: "pretty",
          whiteSpace: "pre-wrap",
        }}
      >
        {children}
      </p>
      {note ? (
        <div
          style={{
            display: "flex",
            gap: 10,
            borderTop: "1px solid var(--g100)",
            paddingTop: 10,
            marginTop: 10,
            fontSize: 12,
            lineHeight: "18px",
            color: "var(--g500)",
            textWrap: "pretty",
          }}
        >
          <span style={{ color: "var(--g300)", flex: "none" }}>Note</span>
          <span>{note}</span>
        </div>
      ) : null}
    </div>
  );
}

/** Prose only — drop the flattened facts card that `answerToText` appended. */
export function chatProseFromStored(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return trimmed.split(/\n+• /)[0]!.replace(/^•\s*/, "").trim();
}

export function groupChatTurns(turns: ThreadTurn[]): Array<{ user?: ThreadTurn; assistant?: ThreadTurn }> {
  const groups: Array<{ user?: ThreadTurn; assistant?: ThreadTurn }> = [];
  for (const turn of turns) {
    if (turn.role === "user") {
      groups.push({ user: turn });
    } else if (groups.length && !groups[groups.length - 1]!.assistant) {
      groups[groups.length - 1]!.assistant = turn;
    } else {
      groups.push({ assistant: turn });
    }
  }
  return groups;
}

function receiptStepperSteps(receipt: ExecutionReceiptSnapshot): StepperStep[] {
  return receipt.steps.map((step, index) => ({
    id: `${receipt.workflowId}-${index}`,
    label: "",
    op: step.operation,
    asset: step.asset,
    amount: step.amount,
    status: step.status === "settled" ? "settled"
      : step.status === "failed" || step.status === "uncertain" ? "failed"
        : step.status === "awaiting_signature" ? "signing"
          : step.status === "submitted" || step.status === "submitting" ? "submitting"
            : step.status === "invoking" ? "claiming" : "pending",
    ...(step.txHash ? { txHash: step.txHash } : {}),
    ...(step.settledLedger != null ? { ledger: step.settledLedger } : {}),
  }));
}

function AssistantTurn({
  text,
  receipt,
  note,
  tone = "default",
  sessionSigning,
}: {
  text: string;
  receipt?: ThreadTurn["executionReceipt"];
  note?: string | null;
  tone?: "default" | "error";
  sessionSigning?: boolean;
}) {
  if (/^Investigation cancelled\./i.test(text)) {
    return (
      <div className="flex items-start gap-3 max-w-[85%]">
        <img
          src="/logos/vanna-icon.png"
          alt="Vanna"
          width={24}
          height={24}
          className="h-6 w-6 shrink-0 mt-0.5 rounded-full"
        />
        <p role="alert" className="flex items-start gap-2 text-[14px] leading-6 text-vgray-700">
          <CircleAlert size={17} className="mt-1 shrink-0 text-imperial-500" aria-hidden="true" />
          <span>{text}</span>
        </p>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-3 max-w-[85%]">
      <img
        src="/logos/vanna-icon.png"
        alt="Vanna"
        width={24}
        height={24}
        className="h-6 w-6 shrink-0 mt-0.5 rounded-full"
      />
      <div className="flex flex-col gap-2 min-w-0 w-full">
        <AssistantMessage note={note} tone={tone}>{chatProseFromStored(text)}</AssistantMessage>
        {receipt ? (
          <div className="w-full">
            <ExecutionStepper
              steps={receiptStepperSteps(receipt)}
              currentStepIndex={Math.max(0, receipt.steps.findIndex((step) => step.status !== "settled"))}
              network={receipt.network}
              autoApprove={sessionSigning}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Live conversation: stored turns, then the in-flight user + the `/api/copilot` reply. */
export function ChatTurns({
  turns,
  hideAssistantText,
  pendingUser,
  working = false,
  liveAssistant,
  liveNote,
  liveTone = "default",
  sessionSigning,
}: {
  turns: ThreadTurn[];
  hideAssistantText?: string | null;
  pendingUser?: string | null;
  working?: boolean;
  liveAssistant?: string | null;
  liveNote?: string | null;
  liveTone?: "default" | "error";
  sessionSigning?: boolean;
}) {
  if (!turns.length && !pendingUser && !liveAssistant && !working) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 34 }} aria-label="Conversation">
      {groupChatTurns(turns).map((group, index) => {
        const hideStaleAssistant = !!hideAssistantText && group.assistant && group.assistant.text === hideAssistantText;
        return (
          <section key={`turn-${index}`} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {group.user ? <UserBubble>{group.user.text}</UserBubble> : null}
            {group.assistant && !hideStaleAssistant ? (
              <AssistantTurn
                text={group.assistant.text}
                receipt={group.assistant.executionReceipt}
                sessionSigning={sessionSigning}
              />
            ) : null}
          </section>
        );
      })}
      {pendingUser || liveAssistant || working ? (
        <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {pendingUser ? <UserBubble>{pendingUser}</UserBubble> : null}
          {liveAssistant ? (
            <AssistantTurn
              text={liveAssistant}
              note={liveNote}
              tone={liveTone}
              sessionSigning={sessionSigning}
            />
          ) : working ? (
            <div className="flex items-start gap-3 max-w-[85%]">
              <img
                src="/logos/vanna-icon.png"
                alt="Vanna"
                width={24}
                height={24}
                className="h-6 w-6 shrink-0 mt-0.5 rounded-full"
              />
              <p role="status" aria-live="polite" className="text-[13px] leading-[20px] text-violet-500">Working…</p>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
