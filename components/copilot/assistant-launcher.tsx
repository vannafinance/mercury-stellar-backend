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

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { X, RefreshCw } from "lucide-react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { useUserStore } from "@/store/user";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import type { CaptureRect } from "@/lib/assistant/capture-page";
import { captureAssistantTurn } from "@/lib/assistant/capture-turn";
import { observeAssistantToasts } from "@/lib/assistant/observe-toasts";
import { MAX_ATTACHMENTS } from "@/lib/assistant/packet";
import { executeClientTools } from "@/lib/assistant/client-tools";
import type { GuideAnswer } from "@/lib/copilot/guide-schema";
import { copilotRequestHeaders } from "@/lib/copilot/copilot-request";
import type { AssistantImageAttachment } from "@/lib/copilot/types";
import { assistantPageLabel } from "@/lib/assistant/page-label";
import type { AssistantPhase } from "@/lib/assistant/phase";
import { getRecentAssistantEvents } from "@/store/assistant-events";
import {
  appendAssistantTurn,
  clearAssistantTurns,
  getAssistantHistory,
  setAssistantOpen,
  useAssistantSessionStore,
} from "@/store/assistant-session";
import { AssistantPanel, type AssistantSendExtras } from "./assistant-panel";
import { AssistantRegionOverlay } from "./assistant-region-overlay";

const ASK_EVENT = "vanna:assistant:ask";
/** Browser abort — must cover guide (60s) + prose fallback on cold Vertex. */
const ASSISTANT_FETCH_MS = 125_000;

function AssistantLauncherInner() {
  const [prefill, setPrefill] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [lastContextPath, setLastContextPath] = useState<string | null>(null);
  const [selectingRegion, setSelectingRegion] = useState(false);
  const [hasRegion, setHasRegion] = useState(false);
  const [composerNonce, setComposerNonce] = useState(0);
  const [phase, setPhase] = useState<AssistantPhase>("idle");
  const pendingRegionRef = useRef<CaptureRect | null>(null);
  const open = useAssistantSessionStore((s) => s.open);
  const turns = useAssistantSessionStore((s) => s.turns);

  const pathname = usePathname();
  const router = useRouter();
  const address = useUserStore((s) => s.address);
  const smartAccount = useMarginAccountInfoStore((s) => s.marginAccountAddress);

  useEffect(() => setMounted(true), []);

  useEffect(() => observeAssistantToasts(), []);

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
      if (e.key !== "Escape") return;
      if (selectingRegion) return;
      setAssistantOpen(false);
    };
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, selectingRegion]);

  const clearRegion = useCallback(() => {
    pendingRegionRef.current = null;
    setHasRegion(false);
    setSelectingRegion(false);
  }, []);

  /**
   * A drawn region is a VIEWPORT rectangle, and the capture resolves it with
   * `getBoundingClientRect()`. So if the page scrolls or navigates between drawing the
   * box and pressing send, the same coordinates now cover different content — the
   * Assistant would answer confidently about a part of the page the user never selected.
   * Dropping the rect is the honest failure: the chip disappears, and the question falls
   * back to the full page capture instead of a silently wrong crop.
   */
  useEffect(() => {
    if (!hasRegion) return;
    const origin = { x: window.scrollX, y: window.scrollY };
    const onScroll = () => {
      if (
        Math.abs(window.scrollX - origin.x) > 24 ||
        Math.abs(window.scrollY - origin.y) > 24
      ) {
        clearRegion();
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [hasRegion, clearRegion]);

  useEffect(() => {
    clearRegion();
  }, [pathname, clearRegion]);

  const send = useCallback(
    async (message: string, extras?: AssistantSendExtras) => {
      const pending = pendingRegionRef.current;
      pendingRegionRef.current = null;
      setHasRegion(false);
      setPhase("capturing");

      // Always re-read the DOM so the model sees the page as it is right now.
      // A selected region contributes region_text + metrics, not a screenshot.
      const capture = captureAssistantTurn({ region: pending });
      if (extras?.selectedText) {
        if (!capture.semantic.selectedText) capture.semantic.selectedText = extras.selectedText;
        if (!capture.snapshot.selection) capture.snapshot.selection = extras.selectedText;
      }
      const readablePage = capture.semantic.sections.length > 0 || capture.semantic.mainText.trim().length > 0;
      const history = getAssistantHistory(8);

      const attachments: AssistantImageAttachment[] = [];
      for (const att of extras?.attachments ?? []) {
        if (attachments.length >= MAX_ATTACHMENTS) break;
        attachments.push(att);
      }

      setLastContextPath(readablePage ? capture.semantic.path : null);
      appendAssistantTurn({ role: "user", text: message });
      setPhase("thinking");

      const t0 = Date.now();
      console.info("[assistant] send", {
        message: message.slice(0, 120),
        path: capture.semantic.path,
        events: getRecentAssistantEvents(5).length,
        attachments: attachments.length,
      });

      try {
        const res = await fetch("/api/copilot", {
          method: "POST",
          headers: await copilotRequestHeaders(),
          signal: AbortSignal.timeout(ASSISTANT_FETCH_MS),
          body: JSON.stringify({
            message,
            user_id: address ?? "guest",
            tier: "paid",
            smart_account: smartAccount ?? null,
            semantic_page_context: capture.semantic,
            page_snapshot: capture.snapshot,
            session_events: getRecentAssistantEvents(5),
            attachments,
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
          guide,
          hasPageContext: readablePage,
        });
        console.info("[assistant] ok", {
          ms: Date.now() - t0,
          request_id: data.request_id,
          kind: data.kind,
        });
        return data;
      } catch (e) {
        const timedOut = e instanceof DOMException && e.name === "TimeoutError";
        console.warn("[assistant] failed", {
          ms: Date.now() - t0,
          timedOut,
          error: e instanceof Error ? e.message : String(e),
        });
        const msg = timedOut
          ? "That took too long and I stopped waiting. Ask again — a shorter question usually comes back faster."
          : e instanceof Error
            ? e.message
            : "Request failed.";
        appendAssistantTurn({ role: "assistant", text: msg, hasPageContext: readablePage });
        throw e;
      } finally {
        setPhase("idle");
      }
    },
    [address, smartAccount, router],
  );

  const onRegionComplete = useCallback((rect: CaptureRect) => {
    setSelectingRegion(false);
    pendingRegionRef.current = rect;
    setHasRegion(true);
  }, []);

  const pageName = assistantPageLabel(pathname);
  const contextLabel =
    phase === "capturing"
      ? `Reading ${pageName}…`
      : phase === "thinking"
        ? "Thinking…"
        : `Looking at ${pageName}`;

  if (!mounted) return null;

  return createPortal(
    <>
      {!open && (
        <button
          type="button"
          aria-label="Ask Vanna Assist"
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
            Assist
          </span>
        </button>
      )}

      {open && (
        <div
          className="fixed inset-0 z-[10000] flex justify-end"
          role="dialog"
          aria-modal="true"
          aria-label="Vanna Assist"
        >
          <button
            type="button"
            aria-label="Close assistant backdrop"
            className="absolute inset-0 bg-black/15 sm:bg-black/10"
            onClick={() => setAssistantOpen(false)}
          />
          <aside
            data-assistant-panel
            aria-label="Vanna Assist — ask about this page"
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
                  Vanna Assist
                </h2>
                <p
                  className={`mt-1 text-[11px] leading-[14px] ${
                    phase !== "idle" ? "font-medium text-violet-500" : "text-vgray-500"
                  }`}
                  aria-live="polite"
                >
                  {phase !== "idle" && (
                    <span
                      className="mr-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400 align-middle"
                      aria-hidden
                    />
                  )}
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
                    clearRegion();
                    setComposerNonce((n) => n + 1);
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
                  aria-label="Close Assist"
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
                key={composerNonce}
                send={send}
                prefill={prefill}
                onConsumedPrefill={() => setPrefill(null)}
                pageLabel={pathname || undefined}
                turns={turns}
                onSelectFromScreen={() => setSelectingRegion(true)}
                hasRegion={hasRegion}
                onClearRegion={clearRegion}
                phase={phase}
              />
            </div>
          </aside>
        </div>
      )}

      <AssistantRegionOverlay
        active={selectingRegion}
        onComplete={onRegionComplete}
        onCancel={() => setSelectingRegion(false)}
      />
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
