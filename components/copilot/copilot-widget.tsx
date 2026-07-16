"use client";

// Vanna Copilot — floating chat widget.
//
// A self-contained, additive UI: a fixed bottom-right launcher that opens a chat
// panel. It talks ONLY to the same-origin proxy (/api/copilot), which forwards to
// the orchestrator "brain". It reads the connected wallet address from the shared
// user store (no extra wallet side-effects) and renders the orchestrator's typed
// ChatResponse by `kind`. Nothing here signs or submits a transaction — a preview
// with `unsigned_xdrs` is surfaced for the mandatory confirm step; wiring the
// signature to Freighter is the documented next step and is intentionally NOT
// done here so existing flows stay untouched.

import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, X, ArrowUp, ShieldCheck, ShieldAlert, ShieldQuestion, Loader2 } from "lucide-react";
import toast from "react-hot-toast";
import { useUserStore } from "@/store/user";
import type { ChatMessage, ChatResponse, Preview, RiskDecision } from "./types";

const SUGGESTIONS = [
  "What's my account health factor?",
  "Supply 500 USDC to Blend",
  "What's the XLM price?",
];

function newId(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function riskStyle(decision: RiskDecision): { label: string; cls: string; Icon: typeof ShieldCheck } {
  switch (decision) {
    case "allow":
      return { label: "Allowed", cls: "text-electric-700 bg-electric-50 border-electric-200", Icon: ShieldCheck };
    case "block":
      return { label: "Blocked", cls: "text-imperial-700 bg-imperial-50 border-imperial-200", Icon: ShieldAlert };
    default:
      return { label: "Needs confirmation", cls: "text-violet-700 bg-violet-50 border-violet-200", Icon: ShieldQuestion };
  }
}

function PreviewCard({
  preview,
  onConfirm,
  disabled,
}: {
  preview: Preview;
  onConfirm: () => void;
  disabled: boolean;
}) {
  const risk = riskStyle(preview.risk.decision);
  const slotEntries = Object.entries(preview.slots ?? {});
  const blocked = preview.risk.decision === "block";

  return (
    <div className="mt-2 rounded-2xl border border-vgray-100 bg-vgray-50 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-h11 text-vgray-900">{preview.template_id}</span>
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-body-4 ${risk.cls}`}>
          <risk.Icon size={12} />
          {risk.label}
        </span>
      </div>

      {slotEntries.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {slotEntries.map(([k, v]) => (
            <span key={k} className="rounded-md bg-surface px-2 py-0.5 text-body-4 text-vgray-500 border border-vgray-100">
              {k}: <span className="text-vgray-900">{String(v)}</span>
            </span>
          ))}
        </div>
      )}

      {preview.risk.reasons.length > 0 && (
        <ul className="mt-2 list-disc pl-4 text-body-3 text-vgray-500">
          {preview.risk.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}

      {preview.requires_signature && !blocked && (
        <button
          type="button"
          onClick={onConfirm}
          disabled={disabled}
          className="mt-3 w-full rounded-xl bg-gradient px-4 py-2 text-btn-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Confirm &amp; Sign
        </button>
      )}
    </div>
  );
}

function MessageBubble({ msg, onConfirm, confirmDisabled }: {
  msg: ChatMessage;
  onConfirm: (p: Preview) => void;
  confirmDisabled: boolean;
}) {
  const isUser = msg.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={
          isUser
            ? "max-w-[85%] rounded-2xl rounded-br-sm bg-gradient px-3.5 py-2 text-body-2 text-white"
            : "max-w-[90%] rounded-2xl rounded-bl-sm bg-vgray-50 px-3.5 py-2 text-body-2 text-vgray-900 border border-vgray-100"
        }
      >
        <p className="whitespace-pre-wrap break-words">{msg.text}</p>
        {msg.preview && (
          <PreviewCard preview={msg.preview} disabled={confirmDisabled} onConfirm={() => onConfirm(msg.preview!)} />
        )}
      </div>
    </div>
  );
}

export function CopilotWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const address = useUserStore((s) => s.address);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading, open]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || loading) return;

      const userMsg: ChatMessage = { id: newId(), role: "user", text: trimmed };
      setMessages((m) => [...m, userMsg]);
      setInput("");
      setLoading(true);

      try {
        const res = await fetch("/api/copilot", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: address ?? "guest", message: trimmed, tier: "free" }),
        });
        const data: ChatResponse = await res.json();
        setMessages((m) => [
          ...m,
          {
            id: newId(),
            role: "assistant",
            text: data.message || "(no response)",
            kind: data.kind,
            preview: data.preview ?? null,
          },
        ]);
      } catch {
        setMessages((m) => [
          ...m,
          { id: newId(), role: "assistant", text: "Something went wrong reaching Copilot. Please try again.", kind: "error" },
        ]);
      } finally {
        setLoading(false);
      }
    },
    [address, loading],
  );

  const handleConfirm = useCallback(
    (preview: Preview) => {
      if (!address) {
        toast.error("Connect your wallet to sign this transaction.");
        return;
      }
      // Boundary: signing is delegated to Freighter and is the documented next
      // integration step. We surface readiness honestly rather than faking a sign.
      toast.success(`Preview confirmed — ${preview.unsigned_xdrs.length} transaction(s) ready to sign.`);
      setMessages((m) => [
        ...m,
        {
          id: newId(),
          role: "assistant",
          text:
            `Ready to sign ${preview.unsigned_xdrs.length} transaction(s) for "${preview.template_id}". ` +
            `The Freighter signing step will be wired here next.`,
          kind: "answer",
        },
      ]);
    },
    [address],
  );

  return (
    <>
      {/* Launcher */}
      {!open && (
        <button
          type="button"
          aria-label="Open Vanna Copilot"
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-[60] flex h-14 w-14 items-center justify-center rounded-full bg-gradient text-white shadow-vanna transition-transform hover:scale-105 active:scale-95"
        >
          <Sparkles size={24} />
        </button>
      )}

      {/* Panel */}
      {open && (
        <div className="fixed bottom-5 right-5 z-[60] flex h-[560px] max-h-[85vh] w-[380px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-3xl border border-vgray-100 bg-surface shadow-vanna">
          {/* Header */}
          <div className="flex items-center justify-between bg-gradient px-4 py-3 text-white">
            <div className="flex items-center gap-2">
              <Sparkles size={18} />
              <div className="leading-tight">
                <p className="text-h11">Vanna Copilot</p>
                <p className="text-body-4 opacity-80">{address ? "Wallet connected" : "Not connected"}</p>
              </div>
            </div>
            <button type="button" aria-label="Close Copilot" onClick={() => setOpen(false)} className="rounded-full p-1 transition-opacity hover:opacity-80">
              <X size={18} />
            </button>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {messages.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center text-center">
                <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-violet-50 text-violet-600">
                  <Sparkles size={22} />
                </div>
                <p className="text-h10 text-vgray-900">How can I help?</p>
                <p className="mt-1 text-body-3 text-vgray-500">Ask about your positions or describe a DeFi action in plain English.</p>
                <div className="mt-4 flex w-full flex-col gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => send(s)}
                      className="rounded-xl border border-vgray-100 bg-vgray-50 px-3 py-2 text-left text-body-3 text-vgray-700 transition-colors hover:border-violet-200 hover:text-violet-700"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m) => (
              <MessageBubble key={m.id} msg={m} onConfirm={handleConfirm} confirmDisabled={loading} />
            ))}

            {loading && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm border border-vgray-100 bg-vgray-50 px-3.5 py-2 text-body-2 text-vgray-500">
                  <Loader2 size={14} className="animate-spin" />
                  Thinking…
                </div>
              </div>
            )}
          </div>

          {/* Composer */}
          <div className="border-t border-vgray-100 bg-surface p-3">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
              }}
              className="flex items-end gap-2 rounded-2xl border border-vgray-200 bg-surface px-3 py-2 focus-within:border-violet-500"
            >
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send(input);
                  }
                }}
                rows={1}
                placeholder="Message Vanna Copilot…"
                className="max-h-28 flex-1 resize-none bg-transparent text-body-2 text-vgray-900 placeholder:text-vgray-400 focus:outline-none"
              />
              <button
                type="submit"
                aria-label="Send message"
                disabled={loading || input.trim() === ""}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                <ArrowUp size={16} />
              </button>
            </form>
            <p className="mt-1.5 px-1 text-body-4 text-vgray-400">
              Copilot can make mistakes. Review every preview before signing.
            </p>
          </div>
        </div>
      )}
    </>
  );
}

export default CopilotWidget;
