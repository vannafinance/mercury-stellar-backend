"use client";

/**
 * Site-wide floating assistant (Gemini Cloud Assist–style).
 * Mounted outside ScaleWrapper so fixed positioning is not transformed.
 */

import { useCallback, useEffect, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { createPortal } from "react-dom";
import { usePageContextApi } from "@/contexts/page-context";
import { useUserStore } from "@/store/user";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { AssistantPanel } from "./assistant-panel";

const ASK_EVENT = "vanna:assistant:ask";

export function AssistantLauncher() {
  const [open, setOpen] = useState(false);
  const [prefill, setPrefill] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const { getPageContext } = usePageContextApi();
  const address = useUserStore((s) => s.address);
  const smartAccount = useMarginAccountInfoStore((s) => s.marginAccountAddress);

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

  const send = useCallback(
    async (message: string) => {
      const res = await fetch("/api/copilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          user_id: address ?? "guest",
          tier: "paid",
          smart_account: smartAccount ?? null,
          page_context: getPageContext(),
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

  return createPortal(
    <>
      {!open && (
        <button
          type="button"
          aria-label="Ask the Vanna assistant"
          onClick={() => {
            setPrefill(null);
            setOpen(true);
          }}
          className="fixed bottom-6 right-6 z-[10000] flex h-14 w-14 items-center justify-center
                     rounded-full bg-gradient-to-br from-[#703AE6] to-[#9B6CFF] text-white
                     shadow-lg transition-transform hover:scale-105 focus:outline-none
                     focus-visible:ring-2 focus-visible:ring-[#703AE6] focus-visible:ring-offset-2"
        >
          <Sparkles size={22} />
        </button>
      )}

      {open && (
        <div className="fixed inset-0 z-[10000] flex items-end justify-end p-4 sm:p-6 pointer-events-none">
          <div
            className="absolute inset-0 bg-black/20 backdrop-blur-[2px] pointer-events-auto sm:bg-transparent sm:backdrop-blur-0"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="relative pointer-events-auto w-full max-w-md">
            <button
              type="button"
              aria-label="Close assistant"
              onClick={() => setOpen(false)}
              className="absolute -top-2 -right-2 z-10 flex h-8 w-8 items-center justify-center
                         rounded-full bg-[#703AE6] text-white shadow-md sm:top-2 sm:right-2"
            >
              <X size={16} />
            </button>
            <AssistantPanel
              send={send}
              page={getPageContext()}
              prefill={prefill}
              onConsumedPrefill={() => setPrefill(null)}
            />
          </div>
        </div>
      )}
    </>,
    document.body,
  );
}

/** Dispatch from any metric `?` affordance — opens launcher with a prefilled ask. */
export function askAssistant(message: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(ASK_EVENT, { detail: { message } }));
}
