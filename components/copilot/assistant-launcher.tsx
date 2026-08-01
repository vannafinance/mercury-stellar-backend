"use client";

/**
 * Site-wide page-aware agent launcher (Gemini master plan).
 * - Semantic pageContext on every send / route change
 * - Client tool execution (navigate / scroll / highlight)
 * - Chat history persists across navigations
 */

import { Suspense, useCallback, useEffect, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "@/contexts/theme-context";
import { useUserStore } from "@/store/user";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { captureSemanticPageContext } from "@/lib/assistant/semantic-page-context";
import { executeClientTools } from "@/lib/assistant/client-tools";
import {
  appendAssistantTurn,
  getAssistantHistory,
  setAssistantOpen,
  useAssistantSessionStore,
} from "@/store/assistant-session";
import { AssistantPanel } from "./assistant-panel";

const ASK_EVENT = "vanna:assistant:ask";

function AssistantLauncherInner() {
  const [prefill, setPrefill] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const open = useAssistantSessionStore((s) => s.open);
  const turns = useAssistantSessionStore((s) => s.turns);

  const { isDark } = useTheme();
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

  // Silently refresh awareness on route change (history is preserved)
  useEffect(() => {
    // Capture is done at send-time; this keeps selectedText listeners warm via panel
  }, [pathname]);

  const send = useCallback(
    async (message: string) => {
      // Always re-read DOM so the model sees the current page (plan 1.3)
      const semantic = captureSemanticPageContext();
      const history = getAssistantHistory(8);

      appendAssistantTurn({ role: "user", text: message });

      try {
        const res = await fetch("/api/copilot", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message,
            user_id: address ?? "guest",
            tier: "paid",
            smart_account: smartAccount ?? null,
            semantic_page_context: semantic,
            history,
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

        const reply = String(data.message || "No reply.");
        appendAssistantTurn({ role: "assistant", text: reply });
        return data;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Request failed.";
        appendAssistantTurn({ role: "assistant", text: msg });
        throw e;
      }
    },
    [address, smartAccount, router],
  );

  if (!mounted) return null;

  const panelBg = isDark ? "bg-[#121212] border-[#2a2a2a]" : "bg-white border-[#e8e8e8]";
  const ink = isDark ? "text-white" : "text-[#111]";
  const muted = isDark ? "text-[#888]" : "text-[#777]";

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
          className={`fixed right-0 top-1/2 z-[10000] -translate-y-1/2 flex flex-col items-center gap-1
                      rounded-l-xl border border-r-0 px-2 py-3 shadow-md transition-colors
                      ${
                        isDark
                          ? "bg-[#1a1a1a] border-[#333] text-[#ddd] hover:bg-[#222]"
                          : "bg-white border-[#e0e0e0] text-[#333] hover:bg-[#fafafa]"
                      }`}
        >
          <Sparkles size={16} className="text-[#703AE6]" />
          <span
            className="text-[10px] font-semibold tracking-wide"
            style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
          >
            Ask page
          </span>
        </button>
      )}

      {open && (
        <div
          className="fixed inset-0 z-[10000] flex justify-end"
          role="dialog"
          aria-modal="true"
          aria-label="Page assistant"
        >
          <button
            type="button"
            aria-label="Close assistant backdrop"
            className="absolute inset-0 bg-black/15 sm:bg-black/10"
            onClick={() => setAssistantOpen(false)}
          />
          <aside
            data-assistant-panel
            className={`relative flex h-full w-full max-w-[400px] flex-col border-l shadow-2xl ${panelBg}`}
            style={{ fontFamily: "var(--font-plus-jakarta-sans), system-ui, sans-serif" }}
          >
            <header
              className={`flex items-center gap-2 border-b px-4 py-3 shrink-0 ${
                isDark ? "border-[#2a2a2a]" : "border-[#ececec]"
              }`}
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#703AE6]/15">
                <Sparkles size={16} className="text-[#703AE6]" />
              </div>
              <div className="min-w-0 flex-1">
                <p className={`text-[14px] font-semibold tracking-tight ${ink}`}>
                  Ask about this page
                </p>
                <p className={`truncate text-[11px] ${muted}`}>{pathname || "/"}</p>
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setAssistantOpen(false)}
                className={`flex h-8 w-8 items-center justify-center rounded-lg ${
                  isDark ? "hover:bg-[#222] text-[#aaa]" : "hover:bg-[#f0f0f0] text-[#666]"
                }`}
              >
                <X size={16} />
              </button>
            </header>

            <div className="min-h-0 flex-1">
              <AssistantPanel
                send={send}
                prefill={prefill}
                onConsumedPrefill={() => setPrefill(null)}
                pageLabel={pathname || undefined}
                turns={turns}
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
