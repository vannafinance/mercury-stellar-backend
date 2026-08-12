"use client";

/**
 * Site-wide page-aware Assistant drawer.
 * - Semantic pageContext captured on every send
 * - Client tool execution (navigate / scroll / highlight)
 * - Chat history persists across navigations
 *
 * The reply is rendered from the structured `guide` the brain returns, not from its
 * flattened text — see guide-answer-view.tsx. `text` is kept on the turn regardless so
 * history stays readable and a turn without structure still renders.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { X, RefreshCw } from "lucide-react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { useUserStore } from "@/store/user";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import {
  captureSemanticPageContext,
  type SemanticPageContext,
} from "@/lib/assistant/semantic-page-context";
import { executeClientTools, scrollToSection } from "@/lib/assistant/client-tools";
import type { GuideAnswer } from "@/lib/copilot/guide-schema";
import { copilotRequestHeaders } from "@/lib/copilot/copilot-request";
import {
  appendAssistantTurn,
  clearAssistantTurns,
  getAssistantHistory,
  setAssistantOpen,
  useAssistantSessionStore,
} from "@/store/assistant-session";
import { AssistantPanel } from "./assistant-panel";

const ASK_EVENT = "vanna:assistant:ask";

/**
 * The on-page element this answer refers to, or null.
 *
 * Only a heading or a `data-copilot-id` target the answer *literally names* qualifies,
 * so "Show me X" can never point somewhere the reader wasn't just told about. The id
 * comes from the DOM the send captured, never from the model.
 */
function derivePageRef(
  guide: GuideAnswer | null,
  page: SemanticPageContext | null,
): { label: string; elementId: string } | null {
  if (!guide || !page) return null;
  const haystack = [guide.summary, ...guide.sections.map((s) => `${s.heading} ${s.body}`)]
    .join(" ")
    .toLowerCase();

  const candidates: Array<{ label: string; elementId: string }> = [
    ...page.sections.flatMap((s) => (s.id ? [{ label: s.text, elementId: s.id }] : [])),
    ...page.interactiveHints.map((h) => ({ label: h.label, elementId: h.id })),
  ];

  let best: { label: string; elementId: string } | null = null;
  for (const c of candidates) {
    const label = c.label.trim();
    if (label.length < 4 || label.length > 40) continue;
    if (!haystack.includes(label.toLowerCase())) continue;
    // The most specific match wins — "Health factor" over "Health".
    if (!best || label.length > best.label.length) best = { label, elementId: c.elementId };
  }
  return best;
}

function AssistantLauncherInner() {
  const [prefill, setPrefill] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [lastContextPath, setLastContextPath] = useState<string | null>(null);
  const open = useAssistantSessionStore((s) => s.open);
  const turns = useAssistantSessionStore((s) => s.turns);

  const pathname = usePathname();
  const router = useRouter();
  const address = useUserStore((s) => s.address);
  const smartAccount = useMarginAccountInfoStore((s) => s.marginAccountAddress);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const onAsk = (ev: Event) => {
      const detail = (ev as CustomEvent<{ message?: string }>).detail;
      const msg = detail?.message?.trim();
      if (msg) setPrefill(msg);
      setAssistantOpen(true);
    };
    window.addEventListener(ASK_EVENT, onAsk as EventListener);
    return () => window.removeEventListener(ASK_EVENT, onAsk as EventListener);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAssistantOpen(false);
    };
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const send = useCallback(
    async (message: string) => {
      // Always re-read the DOM so the model sees the page as it is right now.
      const semantic = captureSemanticPageContext();
      const readablePage = semantic.sections.length > 0 || semantic.mainText.trim().length > 0;
      const history = getAssistantHistory(8);

      setLastContextPath(readablePage ? semantic.path : null);
      appendAssistantTurn({ role: "user", text: message });

      try {
        // A hung model call is indistinguishable from a broken Assistant: the skeleton
        // just sits there. Give up at 90s and say so instead.
        const res = await fetch("/api/copilot", {
          method: "POST",
          headers: await copilotRequestHeaders(),
          signal: AbortSignal.timeout(90_000),
          body: JSON.stringify({
            message,
            user_id: address ?? "guest",
            tier: "paid",
            smart_account: smartAccount ?? null,
            semantic_page_context: semantic,
            history,
            surface: "assistant",
          }),
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          throw new Error(errText || `HTTP ${res.status}`);
        }
        const data = await res.json();

        // Hands: execute client tools returned by the model
        if (Array.isArray(data.client_tools) && data.client_tools.length) {
          executeClientTools(data.client_tools, { router });
        }

        const guide = (data.guide ?? null) as GuideAnswer | null;
        appendAssistantTurn({
          role: "assistant",
          text: String(data.message || "No reply."),
          guide: guide ? { ...guide, pageRef: derivePageRef(guide, semantic) } : null,
          hasPageContext: readablePage,
        });
        return data;
      } catch (e) {
        const timedOut = e instanceof DOMException && e.name === "TimeoutError";
        const msg = timedOut
          ? "That took too long and I stopped waiting. Ask again — a shorter question usually comes back faster."
          : e instanceof Error
            ? e.message
            : "Request failed.";
        appendAssistantTurn({ role: "assistant", text: msg, hasPageContext: readablePage });
        throw e;
      }
    },
    [address, smartAccount, router],
  );

  const showRef = useCallback((ref: { label: string; elementId: string }) => {
    scrollToSection(ref.elementId, true);
  }, []);

  const contextLabel = useMemo(() => {
    if (lastContextPath) return `reading ${lastContextPath}`;
    return pathname ? `on ${pathname}` : "no page context";
  }, [lastContextPath, pathname]);

  if (!mounted) return null;

  return createPortal(
    <>
      {!open && (
        <button
          type="button"
          aria-label="Ask about this page"
          onClick={() => {
            setPrefill(null);
            setAssistantOpen(true);
          }}
          className="cp-root fixed right-0 top-1/2 z-[10000] flex -translate-y-1/2 cursor-pointer flex-col items-center gap-2.5
                     rounded-l-[14px] border border-r-0 border-vgray-100 bg-surface px-2.5 py-[18px]
                     shadow-md transition-colors hover:border-violet-400"
        >
          <Image src="/logos/vanna-icon.png" alt="" width={18} height={18} className="object-contain" />
          <span
            className="text-[12.5px] font-semibold text-vgray-800"
            style={{ writingMode: "vertical-rl" }}
          >
            Assistant
          </span>
        </button>
      )}

      {open && (
        <div
          className="fixed inset-0 z-[10000] flex justify-end"
          role="dialog"
          aria-modal="true"
          aria-label="Vanna Assistant"
        >
          <button
            type="button"
            aria-label="Close assistant backdrop"
            className="absolute inset-0 bg-black/15 sm:bg-black/10"
            onClick={() => setAssistantOpen(false)}
          />
          <aside
            data-assistant-panel
            aria-label="Assistant — ask about this page"
            className="cp-root relative flex h-full w-full max-w-[452px] flex-col border-l border-vgray-100 bg-surface shadow-2xl"
            style={{
              fontFamily: "var(--font-plus-jakarta-sans), system-ui, sans-serif",
              animation: "cp-drawer-in 220ms ease-out",
            }}
          >
            <header className="z-[3] flex shrink-0 items-center gap-2.5 border-b border-vgray-100 bg-surface px-[18px] pt-4 pb-3.5">
              <span
                aria-hidden="true"
                className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-r3 bg-violet-50"
              >
                <Image
                  src="/logos/vanna-icon.png"
                  alt=""
                  width={19}
                  height={19}
                  className="block object-contain"
                />
              </span>
              <div className="flex min-w-0 flex-1 flex-col justify-center">
                <h2 className="text-[15px] font-semibold leading-[18px] text-vgray-900">
                  Vanna Assistant
                </h2>
                <p className="mt-1 truncate font-mono text-[10.5px] leading-3 text-vgray-400">
                  {contextLabel}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  title="Clears this thread completely"
                  onClick={() => {
                    clearAssistantTurns();
                    setPrefill(null);
                    setLastContextPath(null);
                    toast.success("New chat — history cleared", { duration: 2000 });
                  }}
                  disabled={turns.length === 0}
                  className="flex cursor-pointer items-center gap-1.5 rounded-r2 border border-vgray-100 bg-transparent px-2.5 py-1.5 text-[12px] font-semibold text-vgray-800 transition-colors hover:border-violet-50 hover:bg-violet-50 hover:text-violet-500 disabled:cursor-default disabled:opacity-40 disabled:hover:border-vgray-100 disabled:hover:bg-transparent disabled:hover:text-vgray-800"
                >
                  <RefreshCw size={13} />
                  New chat
                </button>
                <button
                  type="button"
                  aria-label="Close Assistant"
                  title="Close"
                  onClick={() => setAssistantOpen(false)}
                  className="flex cursor-pointer rounded-r2 border border-vgray-100 bg-transparent p-[7px] text-vgray-500 transition-colors hover:border-violet-50 hover:bg-violet-50 hover:text-violet-500"
                >
                  <X size={14} />
                </button>
              </div>
            </header>

            <div className="min-h-0 flex-1">
              <AssistantPanel
                send={send}
                prefill={prefill}
                onConsumedPrefill={() => setPrefill(null)}
                pageLabel={pathname || undefined}
                turns={turns}
                onShowRef={showRef}
              />
            </div>
          </aside>
        </div>
      )}
    </>,
    document.body,
  );
}

export function AssistantLauncher() {
  // useSearchParams (via semantic hook if used) needs Suspense in some Next setups
  return (
    <Suspense fallback={null}>
      <AssistantLauncherInner />
    </Suspense>
  );
}

export function askAssistant(message: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(ASK_EVENT, { detail: { message } }));
}
