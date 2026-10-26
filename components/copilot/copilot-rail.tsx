"use client";

import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pin } from "lucide-react";
import { AutoApproveMenu, type AutoApproveMenuProps } from "./auto-approve-menu";
import { zoneOf, zoneLabel } from "./health-dial";
import type { ConversationSummary } from "@/lib/copilot/investigation/thread";
import { COIN_ICONS } from "@/lib/constants/margin";
import { INLINE_COIN_ICONS } from "@/components/copilot/coin-icon-data";
import { HEALTH_FACTOR_INFINITY_SENTINEL } from "@/lib/margin-health";
import { CopilotRailPresentation } from "./copilot-shell";
import Image from "next/image";

/**
 * The left rail's contents: New chat, Auto-approve, health factor, positions, recents.
 *
 * Every figure here is the same value the page already computed - the rail is a second
 * view of one state, never its own copy. The health zone comes from `zoneOf`/`zoneLabel`
 * in health-dial, so the rail cannot disagree with the dial about what "healthy" means.
 *
 * Sizes are the deployed mock's: 14/21 semibold for a section label, 13/20 semibold
 * monospace for a figure, 12/18 for its caption. `min-width: 0` is on every row that
 * holds text, because a flex item defaults to `min-width: auto` - its content's width -
 * and one long conversation title was enough to push the rail past 292px.
 */

const VANNA_FONT = "var(--font-plus-jakarta-sans), system-ui, sans-serif";

function healthFactorLabel(value: number | null): string {
  if (value == null || Number.isNaN(value)) return "-";
  return value >= HEALTH_FACTOR_INFINITY_SENTINEL ? "∞" : value.toFixed(2);
}

/** A value change remounts only its tint, never the rail or any action controls. */
function HealthValue({ value }: { value: number | null }) {
  const [frame, setFrame] = useState({ value, revision: 0 });
  if (!Object.is(frame.value, value)) setFrame({ value, revision: frame.revision + 1 });
  return <span key={frame.revision} className={frame.revision ? "cp-hf-value cp-hf-tint" : "cp-hf-value"}>{healthFactorLabel(value)}</span>;
}

/** One section's two presentations; hover previews, click pins, no account state. */
function RailFlyout({ label, icon, summary, heading, children, order }: {
  label: string; icon: React.ReactNode; summary?: React.ReactNode;
  heading: React.ReactNode; children: React.ReactNode; order: number;
}) {
  const compact = useContext(CopilotRailPresentation);
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [position, setPosition] = useState({ left: 68, top: 0 });
  const clear = () => { if (timer.current) clearTimeout(timer.current); };
  const preview = () => {
    clear();
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) setPosition({ left: Math.max(8, Math.min(rect.right + 8, window.innerWidth - 280)), top: Math.max(8, Math.min(rect.top, window.innerHeight - 180)) });
    setOpen(true);
  };
  const leave = () => {
    clear();
    timer.current = setTimeout(() => {
      if (!pinned.current && !panel.current?.contains(document.activeElement)) setOpen(false);
    }, 160);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (!open) return;
    const close = () => { pinned.current = false; setOpen(false); };
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { close(); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", close);
    const scroll = (event: Event) => { if (!panel.current?.contains(event.target as Node)) close(); };
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open]);
  if (!compact) return <div className="cp-rail-section" style={{ order }}>{heading}{children}</div>;
  return <div className="cp-rail-section" style={{ order }}>
    <button ref={trigger} type="button" className="cp-rail-mix cp-icon-button" aria-label={label} aria-expanded={open} aria-haspopup="dialog" onMouseEnter={preview} onMouseLeave={leave} onFocus={preview} onBlur={leave} onClick={() => { pinned.current = !pinned.current; if (pinned.current) preview(); else setOpen(false); }}>
      {icon}{summary}
    </button>
    {open && createPortal(<div ref={panel} className="cp-root cp-rail-flyout" role="dialog" aria-label={label} style={{ ...position, maxHeight: `calc(100dvh - ${position.top + 8}px)` }} onMouseEnter={clear} onMouseLeave={leave} onFocus={clear} onBlur={leave}>
      {heading}{children}
    </div>, document.body)}
  </div>;
}

function HealthIcon() {
  return <svg className="cp-health-icon" aria-hidden width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3.34 19a10 10 0 1 1 17.32 0" /><path className="cp-health-needle" d="m12 14 4-4" /></svg>;
}

function PositionIcon() {
  return <span className="cp-position-stack" aria-hidden><img src={INLINE_COIN_ICONS.XLM} alt="" width={17} height={17} /><Image src={COIN_ICONS.USDC} alt="" width={17} height={17} /></span>;
}

export interface RailPosition {
  /** Stable key and display symbol, exactly as the account reported it. */
  symbol: string;
  /**
   * The pool's other token, for a paired holding. Its icon sits behind the first one,
   * which is how the mock shows an LP position as one row rather than two.
   */
  pairedSymbol?: string;
  /** "Margin · Collateral", "Margin · Borrowed" - the venue and what the holding is. */
  role: string;
  amount: string;
  usd: string;
}

/** Down chevron for in-place sections (Margin Positions, Earn Positions, Recents). Open rotates it to point up. */
function Caret({ open }: { open: boolean }) {
  return (
    <span
      aria-hidden
      className="cp-rail-caret inline-flex flex-none text-vgray-400"
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
      <div className="cp-rail-new" style={{ padding: "0 16px 4px", order: 1 }}>
        <button
          type="button"
          onClick={onNewChat}
          className="cp-rail-row cp-icon-button flex w-full cursor-pointer items-center gap-2.5 rounded-r2 px-2 py-2 text-[14px] leading-[21px] font-semibold text-vgray-900 transition-colors"
          style={{ marginLeft: -8, marginRight: -8, width: "calc(100% + 16px)" }}
        >
          <NewChatIcon size={16} />
          New chat
        </button>
      </div>
      <div className="cp-rail-auto" style={{ padding: "0 16px", order: 3 }}>
        <AutoApproveMenu {...autoApprove} variant="rail" />
      </div>
    </>
  );
}

/** Health factor, positions, recents - same column as New chat. */
export function CopilotRailBody({
  hasWallet,
  healthFactor,
  positions,
  earnPositions = [],
  earnLoading = false,
  earnError = false,
  accountLoading = false,
  accountError = false,
  onRetryAccount,
  conversations,
  activeId,
  onOpen,
  onRename,
  onDelete,
  onPin,
}: {
  hasWallet: boolean;
  /** Null when there is no account to read, which the rail says rather than showing 0. */
  healthFactor: number | null;
  positions: RailPosition[];
  /** Earn (lending pool) deposits, from the wallet's vTokens: never margin collateral. */
  earnPositions?: RailPosition[];
  earnLoading?: boolean;
  earnError?: boolean;
  accountLoading?: boolean;
  accountError?: boolean;
  onRetryAccount?: () => void;
  conversations: ConversationSummary[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onPin?: (id: string, pinned: boolean) => void;
}) {
  // Position lists start closed on every visit (as on Solana); the user opens the one they want to see.
  const [positionsOpen, setPositionsOpen] = useState(false);
  const [earnOpen, setEarnOpen] = useState(false);
  const [recentsOpen, setRecentsOpen] = useState(true);

  const zone = zoneOf(healthFactor);

  return (
    <div className="cp-rail-body">
      {/* Health factor - the number and the zone, nothing else. The dial, the scale and
          the collateral/borrowed strip stay off the rail by design. */}
      <RailFlyout order={2} label="Health factor" icon={<HealthIcon />} summary={<span className="text-[11px] font-semibold text-vgray-900"><HealthValue value={healthFactor} /></span>} heading={
      <div className="cp-rail-row cp-health-row" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span className="inline-flex w-[22px] flex-none"><HealthIcon /></span>
        <div className="flex-1 text-[14px] leading-[21px] font-semibold text-vgray-900">Health factor</div>
        <div className="flex flex-none items-center gap-1.5" style={{ minWidth: 0 }}>
          <div className="text-[13px] leading-[20px] font-semibold text-vgray-900" style={{ fontFamily: VANNA_FONT }}>
            <HealthValue value={healthFactor} />
          </div>
          <div className="text-[12px] leading-[18px] text-vgray-500" style={{ textTransform: "capitalize" }}>
            {accountLoading ? "Loading" : accountError ? "Unavailable" : zoneLabel(zone)}
          </div>
        </div>
      </div>
      }>
        {!hasWallet && <p className="px-2 pb-2 text-[12px] leading-[18px] text-vgray-500">Connect your wallet to see your health factor and positions.</p>}
        {hasWallet && accountError && <div className="px-2 pb-2 text-[12px] leading-[18px] text-vgray-500" role="status">
          Account refresh failed.{positions.length > 0 ? " Showing previously loaded positions." : " Your positions could not be loaded."}
          {onRetryAccount && <button type="button" onClick={onRetryAccount} className="ml-2 underline">Retry account data</button>}
        </div>}
      </RailFlyout>

      <PositionsFlyout
        label="Margin Positions"
        open={positionsOpen}
        onToggle={() => setPositionsOpen((v) => !v)}
        positions={positions}
        loading={accountLoading}
        error={accountError}
        hasWallet={hasWallet}
        empty="Nothing open."
      />
      <PositionsFlyout
        label="Earn Positions"
        open={earnOpen}
        onToggle={() => setEarnOpen((v) => !v)}
        positions={earnPositions}
        loading={earnLoading}
        error={earnError}
        hasWallet={hasWallet}
        empty="Nothing supplied to the Earn pools."
      />

      <RecentsList
        recentsOpen={recentsOpen}
        onToggle={() => setRecentsOpen((v) => !v)}
        conversations={conversations}
        activeId={activeId}
        onOpen={onOpen}
        onRename={onRename}
        onDelete={onDelete}
        onPin={onPin}
      />
    </div>
  );
}

/** One collapsible list of holdings (Margin Positions, Earn Positions), as a flyout when the rail is compact. */
function PositionsFlyout({ label, open, onToggle, positions, loading, error, hasWallet, empty }: {
  label: string;
  open: boolean;
  onToggle: () => void;
  positions: RailPosition[];
  loading: boolean;
  error: boolean;
  hasWallet: boolean;
  empty: string;
}) {
  // The collapsed rail shows the list in its flyout; there is no dropdown to open there.
  const compact = useContext(CopilotRailPresentation);
  const shown = open || compact;
  return (
    <RailFlyout order={4} label={label} icon={<PositionIcon />} heading={
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="cp-rail-row cp-icon-button flex w-full cursor-pointer items-center gap-2.5 text-vgray-900 transition-colors"
      >
        <PositionIcon />
        <span className="flex-1 text-left text-[14px] leading-[21px] font-semibold">{label}</span>
        <span aria-hidden className="text-[12px] font-normal text-vgray-500">{loading || (error && positions.length === 0) ? "-" : positions.length}</span>
        <Caret open={open} />
      </button>
      }>
      {shown && (
        <div className="cp-position-list">
          {positions.length === 0 ? (
            <p className="text-[12px] leading-[18px] text-vgray-400">{!hasWallet ? "Connect your wallet to see positions." : loading ? "Loading positions…" : error ? "Positions unavailable." : empty}</p>
          ) : (
            positions.map((p) => (
              <div key={`${p.role}:${p.symbol}`} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {/* The app's own icon map, not the mock's assets - a token must not be
                    drawn from two sources that can disagree about what it looks like. */}
                <div style={{ position: "relative", width: p.pairedSymbol ? 26 : 20, height: 20, flex: "none" }}>
                  <img
                    src={INLINE_COIN_ICONS[p.symbol.toUpperCase()] ?? COIN_ICONS[p.symbol.toUpperCase()] ?? "/coins/default.svg"}
                    alt=""
                    width={20}
                    height={20}
                    style={{ position: "absolute", left: 0, top: 0, zIndex: 1, borderRadius: 999 }}
                  />
                  {p.pairedSymbol && (
                    <img
                      src={INLINE_COIN_ICONS[p.pairedSymbol.toUpperCase()] ?? COIN_ICONS[p.pairedSymbol.toUpperCase()] ?? "/coins/default.svg"}
                      alt=""
                      width={20}
                      height={20}
                      style={{ position: "absolute", left: 8, top: 0, zIndex: 0, borderRadius: 999 }}
                    />
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="truncate text-[14px] leading-[21px] font-semibold text-vgray-900">{p.symbol}</div>
                  <div title={p.role} className="truncate text-[12px] leading-[18px] text-vgray-500">{p.role}</div>
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
    </RailFlyout>
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
  onPin,
}: {
  recentsOpen: boolean;
  onToggle: () => void;
  conversations: ConversationSummary[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onPin?: (id: string, pinned: boolean) => void;
}) {
  return (
    <RailFlyout order={5} label="Recents" icon={<RecentIcon size={18} />} heading={
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={recentsOpen}
        className="cp-rail-row cp-icon-button flex w-full cursor-pointer items-center gap-2.5 text-vgray-900 transition-colors"
      >
        <span className="inline-flex w-[22px] flex-none"><RecentIcon size={16} /></span>
        <span title="Chats expire after 30 days of inactivity. Pinned chats and pending transactions are protected." className="flex-1 text-left text-[14px] leading-[21px] font-semibold">Recents</span>
        <Caret open={recentsOpen} />
      </button>
      }>
      {recentsOpen && (
        <div className="cp-recents-list" style={{ padding: "2px 0 4px", display: "flex", flexDirection: "column" }}>
          {conversations.length === 0 ? (
            <p className="text-[12px] leading-[18px] text-vgray-400">No chats yet.</p>
          ) : (
            conversations.map((c) => (
              <RecentRow
                key={c.id}
                id={c.id}
                title={c.title}
                pinned={c.pinned}
                pending={c.pending}
                active={c.id === activeId}
                onOpen={onOpen}
                onRename={onRename}
                onDelete={onDelete}
                onPin={onPin}
              />
            ))
          )}
        </div>
      )}
    </RailFlyout>
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
  pinned,
  pending,
  onOpen,
  onRename,
  onDelete,
  onPin,
}: {
  id: string;
  title: string;
  active: boolean;
  pinned?: boolean;
  pending?: boolean;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onPin?: (id: string, pinned: boolean) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(title);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number; maxHeight?: number; maxWidth?: number }>({ left: 0, top: 0 });
  const row = useRef<HTMLDivElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const canPin = Boolean(onPin && !id.startsWith("local:"));

  useLayoutEffect(() => {
    if (!menuOpen || !menu.current || !menuTrigger.current) return;
    const place = () => {
      if (!menu.current || !menuTrigger.current) return;
      const anchor = menuTrigger.current.getBoundingClientRect();
      const measured = menu.current.getBoundingClientRect();
      const viewport = window.visualViewport;
      const inset = 8;
      const gap = 10;
      const startX = (viewport?.offsetLeft ?? 0) + inset;
      const startY = (viewport?.offsetTop ?? 0) + inset;
      const maxWidth = Math.max(0, (viewport?.width ?? document.documentElement.clientWidth) - inset * 2);
      const maxHeight = Math.max(0, (viewport?.height ?? document.documentElement.clientHeight) - inset * 2);
      const width = Math.min(measured.width, maxWidth);
      const height = Math.min(measured.height, maxHeight);
      const preferredLeft = anchor.right + gap + width <= startX + maxWidth ? anchor.right + gap : anchor.left - gap - width;
      const next = {
        left: Math.max(startX, Math.min(preferredLeft, startX + maxWidth - width)),
        top: Math.max(startY, Math.min(anchor.top, startY + maxHeight - height)),
        maxWidth,
        maxHeight,
      };
      setMenuPosition(current => current.left === next.left && current.top === next.top && current.maxWidth === maxWidth && current.maxHeight === maxHeight ? current : next);
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(menu.current);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", place);
    viewport?.addEventListener("scroll", place);
    return () => {
      observer?.disconnect();
      viewport?.removeEventListener("resize", place);
      viewport?.removeEventListener("scroll", place);
    };
  }, [menuOpen, canPin]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!row.current?.contains(target) && !menu.current?.contains(target)) setMenuOpen(false);
    };
    const closeOnViewportMove = (event: Event) => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      setMenuOpen(false);
    };
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
      style={{ minWidth: 0, margin: "0 -8px", padding: "2px 4px" }}
    >
      <button
        type="button"
        onClick={() => onOpen(id)}
        title={title}
        className={`min-w-0 flex-1 truncate rounded-r2 px-1.5 py-1.5 text-left text-[14px] leading-[21px] ${
          active ? "font-semibold text-vgray-900" : "text-vgray-700"
        }`}
      >
        {pinned && <Pin size={12} className="mr-1 inline-block text-violet-500" aria-label="Pinned chat" />}{title}
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
          aria-label="Chat actions"
          className="cp-root fixed z-[100] w-[150px] overflow-y-auto rounded-r2 border border-vgray-100 bg-surface py-1 shadow-lg"
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
          {onPin && !id.startsWith("local:") && <button
            type="button" role="menuitem"
            onClick={() => { setMenuOpen(false); onPin(id, !pinned); }}
            className="flex w-full cursor-pointer px-3 py-2 text-left text-[13px] text-vgray-800 hover:bg-vgray-50"
          >{pinned ? "Unpin chat" : "Pin chat"}</button>}
          <button
            type="button"
            role="menuitem"
            disabled={pending}
            title={pending ? "Finish or cancel the pending transaction first" : undefined}
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
 * Deliberately not every rail control - a 60px column cannot hold a health factor and a
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
  onPin,
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
  onPin?: (id: string, pinned: boolean) => void;
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
                pinned={conversation.pinned}
                pending={conversation.pending}
                active={conversation.id === activeId}
                onOpen={(id) => { setRecentsOpen(false); onOpen(id); }}
                onRename={onRename}
                onDelete={onDelete}
                onPin={onPin}
              />
            ))}
          </div>
        </div>,
        document.body,
      )}
      <div aria-hidden className="my-0.5 h-px w-[26px] bg-vgray-100" />
      <div
        title={healthFactor == null ? "Health factor unavailable" : `Health factor ${healthFactorLabel(healthFactor)}`}
        className="text-[12px] leading-[18px] font-semibold text-vgray-900"
        style={{ fontFamily: VANNA_FONT }}
      >
        {healthFactorLabel(healthFactor)}
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
