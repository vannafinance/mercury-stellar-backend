"use client";

/**
 * Site-wide page assistant — Gemini in Chrome style.
 *
 * - Right side panel (not a chat bubble popup)
 * - Reads LIVE DOM on every route (analytics included)
 * - Outside ScaleWrapper so layout is not transformed
 */

import { useCallback, useEffect, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { useTheme } from "@/contexts/theme-context";
import { useUserStore } from "@/store/user";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { usePageContextApi } from "@/contexts/page-context";
import { capturePageSnapshot, type PageSnapshot } from "@/lib/assistant/capture-page";
import { AssistantPanel } from "./assistant-panel";

const ASK_EVENT = "vanna:assistant:ask";

export function AssistantLauncher() {
  const [open, setOpen] = useState(false);
  const [prefill, setPrefill] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const { isDark } = useTheme();
  const pathname = usePathname();
  const address = useUserStore((s) => s.address);
  const smartAccount = useMarginAccountInfoStore((s) => s.marginAccountAddress);
  // Optional structured metrics if a page registered them (never required)
  const { getPageContext } = usePageContextApi();

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const onAsk = (ev: Event) => {
      const detail = (ev as CustomEvent<{ message?: string }>).detail;
      const msg = detail?.message?.trim();
      if (msg) setPrefill(msg);
      setOpen(true);
    };
    window.addEventListener(ASK_EVENT, onAsk as EventListener);
    return () => window.removeEventListener(ASK_EVENT, onAsk as EventListener);
  }, []);

  const capture = useCallback(() => capturePageSnapshot({ maxChars: 14_000 }), []);

  const send = useCallback(
    async (
      message: string,
      history: Array<{ role: "user" | "assistant"; text: string }> = [],
      snapshot?: PageSnapshot,
    ) => {
      const snap = snapshot ?? capturePageSnapshot({ maxChars: 14_000 });
      const res = await fetch("/api/copilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          user_id: address ?? "guest",
          tier: "paid",
          smart_account: smartAccount ?? null,
          page_snapshot: snap,
          page_context: getPageContext(),
          history: history.slice(-6),
        }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(errText || `HTTP ${res.status}`);
      }
      return res.json();
    },
    [address, smartAccount, getPageContext],
  );

  if (!mounted) return null;

  const panelBg = isDark ? "bg-[#121212] border-[#2a2a2a]" : "bg-white border-[#e8e8e8]";
  const ink = isDark ? "text-white" : "text-[#111]";
  const muted = isDark ? "text-[#888]" : "text-[#777]";

  return createPortal(
    <>
      {/* Edge tab — page assistant, not a chatbot FAB */}
      {!open && (
        <button
          type="button"
          aria-label="Ask about this page"
          onClick={() => {
            setPrefill(null);
            setOpen(true);
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
            onClick={() => setOpen(false)}
          />
          <aside
            data-assistant-panel
            className={`relative flex h-full w-full max-w-[400px] flex-col border-l shadow-2xl ${panelBg}`}
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
                <p className={`text-[14px] font-semibold ${ink}`}>Ask about this page</p>
                <p className={`truncate text-[11px] ${muted}`}>{pathname || "/"}</p>
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setOpen(false)}
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
                capture={capture}
                prefill={prefill}
                onConsumedPrefill={() => setPrefill(null)}
                pageLabel={pathname || undefined}
              />
            </div>
          </aside>
        </div>
      )}
    </>,
    document.body,
  );
}

export function askAssistant(message: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(ASK_EVENT, { detail: { message } }));
}
