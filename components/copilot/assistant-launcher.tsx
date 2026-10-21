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
import { X, RefreshCw, GripHorizontal, PanelRight, Maximize2 } from "lucide-react";
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
  setAssistantLauncherPos,
  setAssistantLayoutMode,
  setAssistantOpen,
  setAssistantPanelPos,
  useAssistantSessionStore,
  type AssistantCoords,
} from "@/store/assistant-session";
import { AssistantPanel, type AssistantSendExtras } from "./assistant-panel";
import { AssistantRegionOverlay } from "./assistant-region-overlay";

const ASK_EVENT = "vanna:assistant:ask";
const ASSISTANT_FETCH_MS = 90_000;

const FLOATING_WIDTH = 428;
const FLOATING_HEIGHT = 620;
const LAUNCHER_WIDTH = 44;
const LAUNCHER_HEIGHT = 104;
const VIEWPORT_MARGIN = 12;
const TOP_SAFE_MARGIN = 64;

/**
 * Clamp floating coordinates strictly inside the current website viewport so the widget
 * can never be dragged outside the browser tab or under the top navigation bar.
 */
export function clampToViewport(
  x: number,
  y: number,
  width: number,
  height: number,
  vw = typeof window !== "undefined" ? window.innerWidth : 1280,
  vh = typeof window !== "undefined" ? window.innerHeight : 800,
): AssistantCoords {
  const effW = Math.min(width, Math.max(280, vw - VIEWPORT_MARGIN * 2));
  const effH = Math.min(height, Math.max(320, vh - TOP_SAFE_MARGIN - VIEWPORT_MARGIN));
  const minX = VIEWPORT_MARGIN;
  const maxX = Math.max(minX, vw - effW - VIEWPORT_MARGIN);
  const minY = TOP_SAFE_MARGIN;
  const maxY = Math.max(minY, vh - effH - VIEWPORT_MARGIN);
  return {
    x: Math.round(Math.min(Math.max(x, minX), maxX)),
    y: Math.round(Math.min(Math.max(y, minY), maxY)),
  };
}

function defaultFloatingPos(): AssistantCoords {
  if (typeof window === "undefined") return { x: 820, y: 88 };
  return clampToViewport(
    window.innerWidth - FLOATING_WIDTH - 24,
    84,
    FLOATING_WIDTH,
    FLOATING_HEIGHT,
  );
}

function defaultLauncherPos(): AssistantCoords {
  if (typeof window === "undefined") return { x: 1220, y: 340 };
  return clampToViewport(
    window.innerWidth - LAUNCHER_WIDTH - VIEWPORT_MARGIN,
    Math.round(window.innerHeight / 2 - LAUNCHER_HEIGHT / 2),
    LAUNCHER_WIDTH,
    LAUNCHER_HEIGHT,
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
  const layoutMode = useAssistantSessionStore((s) => s.layoutMode ?? "floating");
  const storedPanelPos = useAssistantSessionStore((s) => s.panelPos);
  const storedLauncherPos = useAssistantSessionStore((s) => s.launcherPos);

  const [livePanelPos, setLivePanelPos] = useState<AssistantCoords | null>(null);
  const [liveLauncherPos, setLiveLauncherPos] = useState<AssistantCoords | null>(null);

  const panelRef = useRef<HTMLElement | null>(null);
  const launcherDragMovedRef = useRef(false);

  const pathname = usePathname();
  const router = useRouter();
  const address = useUserStore((s) => s.address);
  const smartAccount = useMarginAccountInfoStore((s) => s.marginAccountAddress);

  useEffect(() => setMounted(true), []);

  useEffect(() => observeAssistantToasts(), []);

  // Keep panel & launcher strictly inside the browser tab on window resize
  useEffect(() => {
    if (!mounted) return;
    const onResize = () => {
      const currentPanel = useAssistantSessionStore.getState().panelPos;
      if (currentPanel) {
        const rect = panelRef.current?.getBoundingClientRect();
        const clamped = clampToViewport(
          currentPanel.x,
          currentPanel.y,
          rect?.width ?? FLOATING_WIDTH,
          rect?.height ?? FLOATING_HEIGHT,
        );
        if (clamped.x !== currentPanel.x || clamped.y !== currentPanel.y) {
          setAssistantPanelPos(clamped);
        }
      }
      const currentLauncher = useAssistantSessionStore.getState().launcherPos;
      if (currentLauncher) {
        const clampedL = clampToViewport(
          currentLauncher.x,
          currentLauncher.y,
          LAUNCHER_WIDTH,
          LAUNCHER_HEIGHT,
        );
        if (clampedL.x !== currentLauncher.x || clampedL.y !== currentLauncher.y) {
          setAssistantLauncherPos(clampedL);
        }
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

  // Drag handler for the open floating Assist panel header
  const onHeaderPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (layoutMode !== "floating") return;
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("button, a, input, textarea, [data-no-drag]")) return;

      e.preventDefault();
      const rect = panelRef.current?.getBoundingClientRect();
      const width = rect?.width ?? FLOATING_WIDTH;
      const height = rect?.height ?? FLOATING_HEIGHT;
      const startCoords = storedPanelPos
        ? clampToViewport(storedPanelPos.x, storedPanelPos.y, width, height)
        : defaultFloatingPos();

      const offsetX = e.clientX - startCoords.x;
      const offsetY = e.clientY - startCoords.y;
      let latest = startCoords;

      const onMove = (ev: PointerEvent) => {
        latest = clampToViewport(ev.clientX - offsetX, ev.clientY - offsetY, width, height);
        setLivePanelPos(latest);
      };

      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        setLivePanelPos(null);
        setAssistantPanelPos(latest);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [layoutMode, storedPanelPos],
  );

  // Drag handler for the closed floating launcher button
  const onLauncherPointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      launcherDragMovedRef.current = false;
      const startCoords = storedLauncherPos
        ? clampToViewport(
            storedLauncherPos.x,
            storedLauncherPos.y,
            LAUNCHER_WIDTH,
            LAUNCHER_HEIGHT,
          )
        : defaultLauncherPos();

      const startClientX = e.clientX;
      const startClientY = e.clientY;
      const offsetX = e.clientX - startCoords.x;
      const offsetY = e.clientY - startCoords.y;
      let latest = startCoords;

      const onMove = (ev: PointerEvent) => {
        const dist = Math.hypot(ev.clientX - startClientX, ev.clientY - startClientY);
        if (dist > 5) {
          launcherDragMovedRef.current = true;
        }
        if (launcherDragMovedRef.current) {
          latest = clampToViewport(
            ev.clientX - offsetX,
            ev.clientY - offsetY,
            LAUNCHER_WIDTH,
            LAUNCHER_HEIGHT,
          );
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

  const effectivePanelPos =
    livePanelPos ??
    (storedPanelPos
      ? clampToViewport(storedPanelPos.x, storedPanelPos.y, FLOATING_WIDTH, FLOATING_HEIGHT)
      : defaultFloatingPos());

  const effectiveLauncherPos =
    liveLauncherPos ??
    (storedLauncherPos
      ? clampToViewport(storedLauncherPos.x, storedLauncherPos.y, LAUNCHER_WIDTH, LAUNCHER_HEIGHT)
      : null);

  const isFloating = layoutMode === "floating";

  return createPortal(
    <>
      {!open && (
        <button
          type="button"
          aria-label="Ask Vanna Assist (drag to reposition)"
          title="Ask Vanna Assist · Drag to move anywhere on page"
          onPointerDown={onLauncherPointerDown}
          onClick={() => {
            if (launcherDragMovedRef.current) {
              launcherDragMovedRef.current = false;
              return;
            }
            setPrefill(null);
            setAssistantOpen(true);
          }}
          style={
            effectiveLauncherPos
              ? {
                  left: `${effectiveLauncherPos.x}px`,
                  top: `${effectiveLauncherPos.y}px`,
                }
              : undefined
          }
          className={`cp-root fixed z-[10000] flex cursor-grab active:cursor-grabbing select-none flex-col items-center gap-2
                     border border-vgray-100 bg-surface px-2.5 py-3.5 shadow-lg transition-colors hover:border-violet-400 ${
                       effectiveLauncherPos
                         ? "rounded-[14px]"
                         : "right-0 top-1/2 -translate-y-1/2 rounded-l-[14px] border-r-0"
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
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          data-assistant-panel
          aria-label="Vanna Assist - ask about this page"
          style={
            isFloating
              ? {
                  left: `${effectivePanelPos.x}px`,
                  top: `${effectivePanelPos.y}px`,
                  width: `min(${FLOATING_WIDTH}px, calc(100vw - ${VIEWPORT_MARGIN * 2}px))`,
                  height: `min(${FLOATING_HEIGHT}px, calc(100vh - ${TOP_SAFE_MARGIN + VIEWPORT_MARGIN}px))`,
                  fontFamily: "var(--font-plus-jakarta-sans), system-ui, sans-serif",
                }
              : {
                  fontFamily: "var(--font-plus-jakarta-sans), system-ui, sans-serif",
                  animation: "cp-drawer-in 220ms ease-out",
                }
          }
          className={
            isFloating
              ? "cp-root fixed z-[10000] flex flex-col overflow-hidden rounded-[18px] border border-vgray-100 bg-surface shadow-2xl"
              : "cp-root fixed top-0 right-0 bottom-0 z-[10000] flex h-full w-full max-w-[452px] flex-col border-l border-vgray-100 bg-surface shadow-2xl"
          }
        >
          <header
            onPointerDown={onHeaderPointerDown}
            className={`z-[3] flex shrink-0 select-none items-center gap-2.5 border-b border-vgray-100 bg-surface px-[16px] pt-3.5 pb-3 ${
              isFloating ? "cursor-grab active:cursor-grabbing" : ""
            }`}
          >
            <span
              aria-hidden="true"
              className="flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-r3 bg-violet-50"
            >
              <Image
                src="/logos/vanna-icon.png"
                alt=""
                width={18}
                height={18}
                className="block object-contain"
              />
            </span>
            <div className="flex min-w-0 flex-1 flex-col justify-center">
              <div className="flex items-center gap-1.5">
                <h2 className="text-[14.5px] font-semibold leading-[18px] text-vgray-900">
                  Vanna Assist
                </h2>
                {isFloating && (
                  <span
                    title="Drag header to move within page"
                    className="inline-flex items-center rounded bg-vgray-50 px-1.5 py-0.5 text-[10px] font-medium text-vgray-500"
                  >
                    Drag
                  </span>
                )}
              </div>
              <p
                className={`mt-0.5 truncate text-[11px] leading-[14px] ${
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
            <div className="flex shrink-0 items-center gap-1.5" data-no-drag>
              <button
                type="button"
                title={isFloating ? "Dock panel to right edge" : "Detach as draggable floating window"}
                aria-label={isFloating ? "Dock to right" : "Float window"}
                onClick={() => setAssistantLayoutMode(isFloating ? "docked" : "floating")}
                className="flex cursor-pointer items-center justify-center rounded-r2 border border-vgray-100 bg-transparent p-[7px] text-vgray-600 transition-colors hover:border-violet-50 hover:bg-violet-50 hover:text-violet-500"
              >
                {isFloating ? <PanelRight size={13} /> : <Maximize2 size={13} />}
              </button>
              <button
                type="button"
                title="Clears this thread completely"
                onClick={() => {
                  clearAssistantTurns();
                  setPrefill(null);
                  setLastContextPath(null);
                  clearRegion();
                  setComposerNonce((n) => n + 1);
                  toast.success("New chat - history cleared", { duration: 2000 });
                }}
                disabled={turns.length === 0}
                className="flex cursor-pointer items-center gap-1 rounded-r2 border border-vgray-100 bg-transparent px-2 py-1.5 text-[11.5px] font-semibold text-vgray-800 transition-colors hover:border-violet-50 hover:bg-violet-50 hover:text-violet-500 disabled:cursor-default disabled:opacity-40 disabled:hover:border-vgray-100 disabled:hover:bg-transparent disabled:hover:text-vgray-800"
              >
                <RefreshCw size={12} />
                New
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
