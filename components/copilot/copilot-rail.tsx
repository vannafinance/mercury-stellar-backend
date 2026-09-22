"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AutoApproveMenu, type AutoApproveMenuProps } from "./auto-approve-menu";
import { zoneOf, zoneLabel } from "./health-dial";
import type { ConversationSummary } from "@/lib/copilot/investigation/thread";
import { COIN_ICONS } from "@/lib/constants/margin";

/**
 * The left rail's contents: New chat, Auto-approve, health factor, positions, recents.
 *
 * Every figure here is the same value the page already computed — the rail is a second
 * view of one state, never its own copy. The health zone comes from `zoneOf`/`zoneLabel`
 * in health-dial, so the rail cannot disagree with the dial about what "healthy" means.
 *
 * Sizes are the deployed mock's: 14/21 semibold for a section label, 13/20 semibold
 * monospace for a figure, 12/18 for its caption. `min-width: 0` is on every row that
 * holds text, because a flex item defaults to `min-width: auto` — its content's width —
 * and one long conversation title was enough to push the rail past 292px.
 */

const VANNA_FONT = "var(--font-plus-jakarta-sans), system-ui, sans-serif";

export interface RailPosition {
  /** Stable key and display symbol, exactly as the account reported it. */
  symbol: string;
  /**
   * The pool's other token, for a paired holding. Its icon sits behind the first one,
   * which is how the mock shows an LP position as one row rather than two.
   */
  pairedSymbol?: string;
  /** "Margin · Collateral", "Margin · Borrowed" — the venue and what the holding is. */
  role: string;
  amount: string;
  usd: string;
}

/** Down chevron for in-place sections (Positions, Recents). Open rotates it to point up. */
function Caret({ open }: { open: boolean }) {
  return (
    <span
      aria-hidden
      className="inline-flex flex-none text-vgray-400"
      style={{ transform: open ? "rotate(180deg)" : "none" }}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M6 9l6 6 6-6" /></svg>
    </span>
  );
}

/** New chat, then Auto-approve. Scrolls with the rest of the rail. */
export function CopilotRailTop({
  onNewChat,
  autoApprove,
}: {
  onNewChat: () => void;
  autoApprove: AutoApproveMenuProps;
}) {
  return (
    <>
      <div style={{ padding: "0 16px 4px" }}>
        <button
          type="button"
          onClick={onNewChat}
          className="cp-icon-button flex w-full cursor-pointer items-center gap-2.5 rounded-r2 px-2 py-2 text-[14px] leading-[21px] font-semibold text-vgray-900 transition-colors hover:bg-violet-50 hover:text-violet-500"
          style={{ marginLeft: -8, marginRight: -8, width: "calc(100% + 16px)" }}
        >
          <NewChatIcon size={16} />
          New chat
        </button>
      </div>
      <div style={{ padding: "0 16px 10px" }}>
        <AutoApproveMenu {...autoApprove} variant="rail" />
      </div>
    </>
  );
}

/** Health factor, positions, recents — same column as New chat. */
export function CopilotRailBody({
  hasWallet,
  healthFactor,
  positions,
  conversations,
  activeId,
  onOpen,
  onRename,
  onDelete,
}: {
  hasWallet: boolean;
  /** Null when there is no account to read, which the rail says rather than showing 0. */
  healthFactor: number | null;
  positions: RailPosition[];
  conversations: ConversationSummary[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const [positionsOpen, setPositionsOpen] = useState(true);
  const [recentsOpen, setRecentsOpen] = useState(true);

  if (!hasWallet) {
    return (
      <div style={{ minWidth: 0, padding: "4px 16px 16px", display: "flex", flexDirection: "column", gap: 16 }}>
        <p className="text-[13px] leading-[20px] text-vgray-500">
          Connect your wallet to see your health factor and positions.
        </p>
        <RecentsList
          recentsOpen={recentsOpen}
          onToggle={() => setRecentsOpen((v) => !v)}
          conversations={conversations}
          activeId={activeId}
          onOpen={onOpen}
          onRename={onRename}
          onDelete={onDelete}
        />
      </div>
    );
  }

  const zone = zoneOf(healthFactor);

  return (
    <div style={{ minWidth: 0, padding: "4px 16px 16px", display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Health factor — the number and the zone, nothing else. The dial, the scale and
          the collateral/borrowed strip stay off the rail by design. */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <div className="text-[14px] leading-[21px] font-semibold text-vgray-900">Health factor</div>
        <div style={{ flex: "none", textAlign: "right", minWidth: 0 }}>
          <div className="text-[13px] leading-[20px] font-semibold text-vgray-900" style={{ fontFamily: VANNA_FONT }}>
            {healthFactor == null ? "—" : healthFactor.toFixed(2)}
          </div>
          <div className="text-[12px] leading-[18px] text-vgray-500" style={{ textTransform: "capitalize" }}>
            {zoneLabel(zone)}
          </div>
        </div>
      </div>

      <div>
        <button
          type="button"
          onClick={() => setPositionsOpen((v) => !v)}
          aria-expanded={positionsOpen}
          className="cp-icon-button flex w-full cursor-pointer items-center gap-1.5 py-0.5 text-vgray-900 transition-colors hover:text-violet-500"
        >
          <span className="flex-1 text-left text-[14px] leading-[21px] font-semibold">Positions</span>
          <Caret open={positionsOpen} />
        </button>
        {positionsOpen && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "8px 0 2px" }}>
            {positions.length === 0 ? (
              <p className="text-[12px] leading-[18px] text-vgray-400">Nothing open.</p>
            ) : (
              positions.map((p) => (
                <div key={`${p.role}:${p.symbol}`} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {/* The app's own icon map, not the mock's assets — a token must not be
                      drawn from two sources that can disagree about what it looks like. */}
                  <div style={{ position: "relative", width: p.pairedSymbol ? 26 : 20, height: 20, flex: "none" }}>
                    <img
                      src={COIN_ICONS[p.symbol.toUpperCase()] ?? "/coins/default.svg"}
                      alt=""
                      width={20}
                      height={20}
                      style={{ position: "absolute", left: 0, top: 0, zIndex: 1, borderRadius: 999 }}
                    />
                    {p.pairedSymbol && (
                      <img
                        src={COIN_ICONS[p.pairedSymbol.toUpperCase()] ?? "/coins/default.svg"}
                        alt=""
                        width={20}
                        height={20}
                        style={{ position: "absolute", left: 8, top: 0, zIndex: 0, borderRadius: 999 }}
                      />
                    )}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="truncate text-[14px] leading-[21px] font-semibold text-vgray-900">{p.symbol}</div>
                    <div className="truncate text-[12px] leading-[18px] text-vgray-500">{p.role}</div>
                  </div>
                  <div style={{ flex: "none", textAlign: "right" }}>
                    <div className="text-[13px] leading-[20px] font-semibold text-vgray-900" style={{ fontFamily: VANNA_FONT }}>{p.amount}</div>
                    <div className="text-[12px] leading-[18px] text-vgray-400" style={{ fontFamily: VANNA_FONT }}>{p.usd}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <RecentsList
        recentsOpen={recentsOpen}
        onToggle={() => setRecentsOpen((v) => !v)}
        conversations={conversations}
        activeId={activeId}
        onOpen={onOpen}
        onRename={onRename}
        onDelete={onDelete}
      />
    </div>
  );
}

function RecentsList({
  recentsOpen,
  onToggle,
  conversations,
  activeId,
  onOpen,
  onRename,
  onDelete,
}: {
  recentsOpen: boolean;
  onToggle: () => void;
  conversations: ConversationSummary[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={recentsOpen}
        className="flex w-full cursor-pointer items-center gap-1.5 py-0.5 text-vgray-900 transition-colors hover:text-violet-500"
      >
        <RecentIcon size={14} />
        <span className="flex-1 text-left text-[14px] leading-[21px] font-semibold">Recents</span>
        <Caret open={recentsOpen} />
      </button>
      {recentsOpen && (
        <div style={{ padding: "6px 0 4px", display: "flex", flexDirection: "column" }}>
          {conversations.length === 0 ? (
            <p className="text-[12px] leading-[18px] text-vgray-400">No chats yet.</p>
          ) : (
            conversations.map((c) => (
              <RecentRow
                key={c.id}
                id={c.id}
                title={c.title}
                active={c.id === activeId}
                onOpen={onOpen}
                onRename={onRename}
                onDelete={onDelete}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One conversation. The ⋯ appears on hover and opens rename/delete; renaming swaps the
 * title for an input in place, which is why this row owns a little state of its own.
 */
function RecentRow({
  id,
  title,
  active,
  onOpen,
  onRename,
  onDelete,
}: {
  id: string;
  title: string;
  active: boolean;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(title);
  const [menuPosition, setMenuPosition] = useState({ left: 302, top: 0 });
  const row = useRef<HTMLDivElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!row.current?.contains(target) && !menu.current?.contains(target)) setMenuOpen(false);
    };
    const closeOnViewportMove = () => setMenuOpen(false);
    document.addEventListener("pointerdown", close);
    window.addEventListener("resize", closeOnViewportMove);
    window.addEventListener("scroll", closeOnViewportMove, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", closeOnViewportMove);
      window.removeEventListener("scroll", closeOnViewportMove, true);
    };
  }, [menuOpen]);

  const toggleMenu = () => {
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    const rect = menuTrigger.current?.getBoundingClientRect();
    if (rect) {
      const menuHeight = 82;
      setMenuPosition({
        left: Math.min(rect.right + 10, window.innerWidth - 160),
        top: Math.max(8, Math.min(rect.top, window.innerHeight - menuHeight - 8)),
      });
    }
    setMenuOpen(true);
  };

  const commit = () => {
    const next = draft.trim();
    setRenaming(false);
    // An empty or unchanged title is not a rename; keep what the list already shows.
    if (next && next !== title) onRename(id, next);
    else setDraft(title);
  };

  if (renaming) {
    return (
      <div ref={row} className="group relative flex items-center" style={{ minWidth: 0 }}>
        <input
          autoFocus
          value={draft}
          aria-label="Rename chat"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") { setDraft(title); setRenaming(false); }
          }}
          className="m-1 min-w-0 flex-1 rounded-md border border-violet-500 bg-surface px-2 py-1 text-[14px] leading-[21px] text-vgray-900 outline-none"
        />
      </div>
    );
  }

  return (
    <div
      ref={row}
      className={`group relative flex items-center gap-0.5 rounded-r2 ${
        active || menuOpen ? "bg-vgray-50" : "hover:bg-vgray-50"
      }`}
      style={{ minWidth: 0, margin: "0 -6px", padding: "2px 4px" }}
    >
      <button
        type="button"
        onClick={() => onOpen(id)}
        title={title}
        className={`min-w-0 flex-1 truncate rounded-r2 px-1.5 py-1.5 text-left text-[14px] leading-[21px] ${
          active ? "font-semibold text-vgray-900" : "text-vgray-700"
        }`}
      >
        {title}
      </button>
      <button
        ref={menuTrigger}
        type="button"
        aria-label="Chat actions"
        title="More"
        onClick={toggleMenu}
        className={`flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded-md text-vgray-400 transition-opacity hover:bg-vgray-100 hover:text-vgray-900 ${
          menuOpen || active ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        }`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
        </svg>
      </button>
      {menuOpen && createPortal(
        <div
          ref={menu}
          role="menu"
          className="cp-root fixed z-[100] w-[150px] overflow-hidden rounded-r2 border border-vgray-100 bg-surface py-1 shadow-lg"
          style={menuPosition}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => { setMenuOpen(false); setDraft(title); setRenaming(true); }}
            className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-[13px] text-vgray-800 hover:bg-vgray-50"
          >
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => { setMenuOpen(false); onDelete(id); }}
            className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-[13px] text-[var(--z-danger)] hover:bg-vgray-50"
          >
            Delete
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}

/**
 * The collapsed rail: the few controls that still need to be reachable at 60px.
 *
 * Deliberately not every rail control — a 60px column cannot hold a health factor and a
 * positions list without lying about them. Expanding is one click away, and the icons
 * here are the ones that start work rather than report it.
 */
export function CopilotRailMini({
  onExpand,
  onNewChat,
  autoApprove,
  healthFactor,
  conversations,
  activeId,
  onOpen,
  onRename,
  onDelete,
}: {
  onExpand: () => void;
  onNewChat: () => void;
  autoApprove: AutoApproveMenuProps;
  healthFactor: number | null;
  conversations: ConversationSummary[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const [recentsOpen, setRecentsOpen] = useState(false);
  const recentTrigger = useRef<HTMLButtonElement | null>(null);
  const recentFlyout = useRef<HTMLDivElement | null>(null);
  const [flyoutPosition, setFlyoutPosition] = useState({ left: 68, top: 0 });
  const icon =
    "cp-icon-button flex h-[34px] w-[34px] cursor-pointer items-center justify-center rounded-r2 text-vgray-500 transition-colors hover:bg-violet-50 hover:text-violet-500";

  useEffect(() => {
    if (!recentsOpen) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!recentTrigger.current?.contains(target) && !recentFlyout.current?.contains(target)) setRecentsOpen(false);
    };
    const closeOnViewportMove = () => setRecentsOpen(false);
    document.addEventListener("pointerdown", close);
    window.addEventListener("resize", closeOnViewportMove);
    window.addEventListener("scroll", closeOnViewportMove, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", closeOnViewportMove);
      window.removeEventListener("scroll", closeOnViewportMove, true);
    };
  }, [recentsOpen]);

  const toggleRecents = () => {
    if (!recentsOpen) {
      const rect = recentTrigger.current?.getBoundingClientRect();
      if (rect) {
        const width = 264;
        const estimatedHeight = Math.min(360, 62 + Math.max(1, conversations.length) * 36);
        setFlyoutPosition({
          left: Math.min(rect.right + 8, window.innerWidth - width - 8),
          top: Math.max(8, Math.min(rect.top - 8, window.innerHeight - estimatedHeight - 8)),
        });
      }
    }
    setRecentsOpen((open) => !open);
  };

  return (
    <>
      <button type="button" onClick={onExpand} title="Expand the panel" aria-label="Expand the panel" className={icon}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" />
        </svg>
      </button>
      <button type="button" onClick={onNewChat} title="New chat" aria-label="New chat" className={icon}>
        <NewChatIcon />
      </button>
      <AutoApproveMenu {...autoApprove} variant="mini" />
      <button ref={recentTrigger} type="button" onClick={toggleRecents} aria-expanded={recentsOpen} title="Recent chats" aria-label="Recent chats" className={icon}>
        <RecentIcon />
      </button>
      {recentsOpen && createPortal(
        <div
          ref={recentFlyout}
          className="cp-root fixed z-[100] w-[264px] overflow-hidden rounded-r3 border border-vgray-100 bg-surface p-2 shadow-lg"
          style={flyoutPosition}
          aria-label="Recent chats menu"
        >
          <div className="flex items-center justify-between px-2 py-1.5">
            <span className="text-[13px] font-semibold text-vgray-900">Recents</span>
            <button type="button" onClick={() => setRecentsOpen(false)} className="rounded-md px-1.5 py-0.5 text-[15px] text-vgray-400 hover:bg-vgray-50 hover:text-vgray-900" aria-label="Close recent chats">×</button>
          </div>
          <div className="max-h-[290px] overflow-y-auto px-1 pb-1">
            {conversations.length === 0 ? (
              <p className="px-1 py-2 text-[12px] leading-[18px] text-vgray-400">No chats yet.</p>
            ) : conversations.map((conversation) => (
              <RecentRow
                key={conversation.id}
                id={conversation.id}
                title={conversation.title}
                active={conversation.id === activeId}
                onOpen={(id) => { setRecentsOpen(false); onOpen(id); }}
                onRename={onRename}
                onDelete={onDelete}
              />
            ))}
          </div>
        </div>,
        document.body,
      )}
      <div aria-hidden className="my-0.5 h-px w-[26px] bg-vgray-100" />
      <div
        title={healthFactor == null ? "Health factor unavailable" : `Health factor ${healthFactor.toFixed(2)}`}
        className="text-[12px] leading-[18px] font-semibold text-vgray-900"
        style={{ fontFamily: VANNA_FONT }}
      >
        {healthFactor == null ? "—" : healthFactor.toFixed(2)}
      </div>
    </>
  );
}

function NewChatIcon({ size = 17 }: { size?: number }) {
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

function RecentIcon({ size = 17 }: { size?: number }) {
  return (
    <svg className="cp-sidebar-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <g className="cp-recent-arc">
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
        <path d="M3 3v5h5" />
      </g>
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
