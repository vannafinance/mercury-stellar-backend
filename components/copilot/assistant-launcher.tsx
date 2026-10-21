"use client";

/**
 * Site-wide page-aware Vanna Assist widget.
 * - Floating & draggable anywhere within the website viewport (strictly clamped to tab bounds)
 * - Toggleable between Floating Window and Docked Right Drawer
 * - Non-blocking: underlying Vanna pages remain clickable while Assist is open
 * - Semantic pageContext captured on every send + client tool execution
 * - One-click handoff to Vanna Copilot for on-chain actions
 */

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { X, GripHorizontal } from "lucide-react";
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
  assistantChatTitle,
  getAssistantHistory,
  setAssistantLauncherPos,
  setAssistantOpen,
  useAssistantSessionStore,
  type AssistantCoords,
} from "@/store/assistant-session";
import { AssistantPanel, type AssistantSendExtras } from "./assistant-panel";
import { AssistantHistoryMenu } from "./assistant-history-menu";
import { AssistantRegionOverlay } from "./assistant-region-overlay";

const ASK_EVENT = "vanna:assistant:ask";
const ASSISTANT_FETCH_MS = 90_000;

const LAUNCHER_WIDTH = 44;
const LAUNCHER_HEIGHT = 104;
const VIEWPORT_MARGIN = 12;
const TOP_SAFE_MARGIN = 64;

/** The closed tab is docked to the right edge: only its height on the page moves, never its side. */
export function clampLauncherY(y: number, vh = typeof window !== "undefined" ? window.innerHeight : 800): number {
  const minY = TOP_SAFE_MARGIN;
  const maxY = Math.max(minY, vh - LAUNCHER_HEIGHT - VIEWPORT_MARGIN);
  return Math.round(Math.min(Math.max(y, minY), maxY));
}

function defaultLauncherPos(): AssistantCoords {
  if (typeof window === "undefined") return { x: 0, y: 340 };
  return { x: 0, y: clampLauncherY(Math.round(window.innerHeight / 2 - LAUNCHER_HEIGHT / 2)) };
}

/** The same new-chat drawing the Copilot rail uses, so both read as one control. */
function NewChatIcon({ size = 16 }: { size?: number }) {
  return (
    <svg className="cp-sidebar-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <g className="cp-new-chat-pen">
        <path d="M18.375 2.625a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4Z" />
        <path d="m15 5 3 3" />
      </g>
    </svg>
  );
}

function AssistantLauncherInner() {
  const [prefill, setPrefill] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [, setLastContextPath] = useState<string | null>(null);
  const [selectingRegion, setSelectingRegion] = useState(false);
  const [hasRegion, setHasRegion] = useState(false);
  const [composerNonce, setComposerNonce] = useState(0);
  const [phase, setPhase] = useState<AssistantPhase>("idle");
  const pendingRegionRef = useRef<CaptureRect | null>(null);

  const open = useAssistantSessionStore((s) => s.open);
  const turns = useAssistantSessionStore((s) => s.turns);
  const storedLauncherPos = useAssistantSessionStore((s) => s.launcherPos);

  const [liveLauncherPos, setLiveLauncherPos] = useState<AssistantCoords | null>(null);

  const launcherDragMovedRef = useRef(false);

  const pathname = usePathname();
  const router = useRouter();
  const address = useUserStore((s) => s.address);
  const smartAccount = useMarginAccountInfoStore((s) => s.marginAccountAddress);

  useEffect(() => setMounted(true), []);

  useEffect(() => observeAssistantToasts(), []);

  // Keep the docked tab inside the window when it is resized
  useEffect(() => {
    if (!mounted) return;
    const onResize = () => {
      const currentLauncher = useAssistantSessionStore.getState().launcherPos;
      if (currentLauncher) {
        const clampedY = clampLauncherY(currentLauncher.y);
        if (clampedY !== currentLauncher.y) setAssistantLauncherPos({ x: 0, y: clampedY });
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [mounted]);

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

  const handleOpenInCopilot = useCallback(
    (prompt: string) => {
      const clean = prompt.trim();
      if (!clean) return;
      try {
        window.sessionStorage.setItem("vanna.copilot.handoff", clean);
        window.dispatchEvent(
          new CustomEvent("vanna:copilot-handoff", { detail: { prompt: clean } }),
        );
      } catch {
        // ignore storage errors
      }
      setAssistantOpen(false);
      router.push("/copilot");
    },
    [router],
  );

  // Drag handler for the closed tab: up and down only
  const onLauncherPointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      launcherDragMovedRef.current = false;
      const startY = storedLauncherPos
        ? clampLauncherY(storedLauncherPos.y)
        : defaultLauncherPos().y;

      const startClientY = e.clientY;
      const offsetY = e.clientY - startY;
      let latest: AssistantCoords = { x: 0, y: startY };

      const onMove = (ev: PointerEvent) => {
        if (Math.abs(ev.clientY - startClientY) > 5) {
          launcherDragMovedRef.current = true;
        }
        if (launcherDragMovedRef.current) {
          latest = { x: 0, y: clampLauncherY(ev.clientY - offsetY) };
          setLiveLauncherPos(latest);
        }
      };

      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (launcherDragMovedRef.current) {
          setLiveLauncherPos(null);
          setAssistantLauncherPos(latest);
        }
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [storedLauncherPos],
  );

  const send = useCallback(
    async (message: string, extras?: AssistantSendExtras) => {
      const pending = pendingRegionRef.current;
      pendingRegionRef.current = null;
      setHasRegion(false);
      setPhase("capturing");

      const capture = captureAssistantTurn({ region: pending });
      if (extras?.selectedText) {
        if (!capture.semantic.selectedText) capture.semantic.selectedText = extras.selectedText;
        if (!capture.snapshot.selection) capture.snapshot.selection = extras.selectedText;
      }
      const readablePage =
        capture.semantic.sections.length > 0 || capture.semantic.mainText.trim().length > 0;
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

        if (Array.isArray(data.client_tools) && data.client_tools.length) {
          executeClientTools(data.client_tools, { router });
        }

        const guide = (data.guide ?? null) as GuideAnswer | null;
        const handoff =
          guide?.copilotHandoffPrompt ??
          (typeof data?.data?.copilotHandoffPrompt === "string"
            ? data.data.copilotHandoffPrompt
            : null);

        appendAssistantTurn({
          role: "assistant",
          text: String(data.message || "No reply."),
          guide,
          hasPageContext: readablePage,
          ...(handoff ? { copilotHandoffPrompt: handoff } : {}),
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
          ? "That took too long and I stopped waiting. Ask again - a shorter question usually comes back faster."
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

  const effectiveLauncherPos =
    liveLauncherPos ??
    (storedLauncherPos
      ? { x: 0, y: clampLauncherY(storedLauncherPos.y) }
      : null);

  return createPortal(
    <>
      {!open && (
        <button
          type="button"
          aria-label="Ask Vanna Assist (drag to reposition)"
          title="Ask Vanna Assist · Drag up or down to move"
          onPointerDown={onLauncherPointerDown}
          onClick={() => {
            if (launcherDragMovedRef.current) {
              launcherDragMovedRef.current = false;
              return;
            }
            setPrefill(null);
            setAssistantOpen(true);
          }}
          style={effectiveLauncherPos ? { top: `${effectiveLauncherPos.y}px` } : undefined}
          className={`cp-root fixed right-0 z-[10000] flex cursor-grab active:cursor-grabbing select-none flex-col items-center gap-2
                     rounded-l-[14px] border border-r-0 border-vgray-100 bg-surface px-2.5 py-3.5 shadow-lg transition-colors hover:border-violet-400 ${
                       effectiveLauncherPos ? "" : "top-1/2 -translate-y-1/2"
                     }`}
        >
          <GripHorizontal size={12} className="text-vgray-400" aria-hidden />
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
        <aside
          role="dialog"
          aria-modal="false"
          data-assistant-panel
          aria-label="Vanna Assist - ask about this page"
          style={{
            fontFamily: "var(--font-plus-jakarta-sans), system-ui, sans-serif",
            animation: "cp-drawer-in 220ms ease-out",
          }}
          className="cp-root fixed top-0 right-0 bottom-0 z-[10000] flex h-full w-full max-w-[452px] flex-col border-l border-vgray-100 bg-surface shadow-2xl"
        >
          <header className="z-[3] flex shrink-0 select-none items-center gap-1.5 border-b border-vgray-100 bg-surface py-2.5 pl-[18px] pr-3">
            <h2
              className="min-w-0 flex-1 truncate text-[14.5px] font-semibold leading-[20px] text-vgray-900"
              title={turns.length ? assistantChatTitle(turns) : "New chat"}
            >
              {turns.length ? assistantChatTitle(turns) : "New chat"}
            </h2>
            <span className="sr-only" aria-live="polite">{contextLabel}</span>
            <div className="flex shrink-0 items-center gap-0.5" data-no-drag>
              <AssistantHistoryMenu
                onOpened={() => {
                  setPrefill(null);
                  setLastContextPath(null);
                  clearRegion();
                  setComposerNonce((n) => n + 1);
                }}
              />
              <button
                type="button"
                aria-label="New chat"
                title="New chat"
                onClick={() => {
                  clearAssistantTurns();
                  setPrefill(null);
                  setLastContextPath(null);
                  clearRegion();
                  setComposerNonce((n) => n + 1);
                }}
                disabled={turns.length === 0}
                className="cp-icon-button flex cursor-pointer items-center justify-center rounded-r2 p-[7px] text-vgray-900 transition-colors hover:bg-violet-50 hover:text-violet-500 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-vgray-900"
              >
                <NewChatIcon size={16} />
              </button>
              <button
                type="button"
                aria-label="Close Assist"
                title="Close"
                onClick={() => setAssistantOpen(false)}
                className="flex cursor-pointer items-center justify-center rounded-r2 p-[7px] text-vgray-500 transition-colors hover:bg-violet-50 hover:text-violet-500"
              >
                <X size={16} />
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
              onOpenInCopilot={handleOpenInCopilot}
            />
          </div>
        </aside>
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
