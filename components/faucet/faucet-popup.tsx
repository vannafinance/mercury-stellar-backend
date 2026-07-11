"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect, useMemo } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/contexts/theme-context";
import {
  FAUCET_TOKEN_META,
  type FaucetTokenId,
  type FaucetResult,
  runFaucet,
} from "@/lib/faucet-utils";
import toast from "react-hot-toast";

interface FaucetPopupProps {
  isOpen: boolean;
  onClose: () => void;
  walletAddress: string | null;
}

type Status = "idle" | "loading" | "success" | "error";

interface RowState {
  status: Status;
  message?: string;
  hash?: string;
  /** Wall-clock ms timestamp of last successful mint — drives cooldown. */
  lastMintAt?: number;
}

const ALL_TOKENS: FaucetTokenId[] = ["XLM", "BLEND_USDC", "AQUARIUS_USDC", "SOROSWAP_USDC"];

// Persist one-time mint success per (wallet, token) so refreshing the page
// doesn't allow re-minting an already-funded account. Cooldown timestamps
// are also kept here so the rate-limit ticker survives page reloads.
const STORAGE_KEY = "vanna_faucet_state_v1";
type PersistedState = Partial<Record<FaucetTokenId, { lastMintAt?: number; oneTimeDone?: boolean }>>;

const readPersisted = (wallet: string | null): PersistedState => {
  if (!wallet || typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(`${STORAGE_KEY}:${wallet}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as PersistedState) : {};
  } catch {
    return {};
  }
};

const writePersisted = (wallet: string | null, state: PersistedState) => {
  if (!wallet || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${STORAGE_KEY}:${wallet}`, JSON.stringify(state));
  } catch {
    /* quota / serialization — non-fatal */
  }
};

const initialRows = (): Record<FaucetTokenId, RowState> => ({
  XLM: { status: "idle" },
  BLEND_USDC: { status: "idle" },
  AQUARIUS_USDC: { status: "idle" },
  SOROSWAP_USDC: { status: "idle" },
});

export const FaucetPopup = ({ isOpen, onClose, walletAddress }: FaucetPopupProps) => {
  const { isDark } = useTheme();
  const [rows, setRows] = useState<Record<FaucetTokenId, RowState>>(initialRows);
  const [isMintingAll, setIsMintingAll] = useState(false);
  // Tick once per second to recompute cooldown countdowns. Without this the
  // remaining-seconds label would only update on user interaction.
  const [, setNowTick] = useState(0);

  // Hydrate persisted one-time mint state when the wallet changes — keeps
  // XLM / Blend USDC disabled across page reloads if they were already
  // funded for this account.
  useEffect(() => {
    if (!walletAddress) {
      setRows(initialRows());
      return;
    }
    const persisted = readPersisted(walletAddress);
    setRows((prev) => {
      const next = { ...prev };
      (Object.keys(persisted) as FaucetTokenId[]).forEach((token) => {
        const entry = persisted[token];
        if (!entry) return;
        if (entry.oneTimeDone) {
          next[token] = {
            status: "success",
            message: "Already funded",
            lastMintAt: entry.lastMintAt,
          };
        } else if (entry.lastMintAt) {
          next[token] = { ...next[token], lastMintAt: entry.lastMintAt };
        }
      });
      return next;
    });
  }, [walletAddress]);

  // Drive the cooldown countdown ticker only while the popup is open.
  useEffect(() => {
    if (!isOpen) return;
    const id = window.setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [isOpen]);

  const updateRow = (token: FaucetTokenId, patch: Partial<RowState>) => {
    setRows((prev) => ({ ...prev, [token]: { ...prev[token], ...patch } }));
  };

  const applyResult = (token: FaucetTokenId, result: FaucetResult) => {
    if (result.ok) {
      const message = result.alreadyFunded ? "Already funded" : "Minted";
      const stamp = Date.now();
      updateRow(token, { status: "success", message, hash: result.hash, lastMintAt: stamp });
      // Persist for one-time tokens so refresh doesn't re-enable them.
      const meta = FAUCET_TOKEN_META[token];
      if (meta.category === "one-time" || meta.category === "cooldown") {
        const persisted = readPersisted(walletAddress);
        persisted[token] = {
          ...(persisted[token] ?? {}),
          lastMintAt: stamp,
          oneTimeDone: meta.category === "one-time" || persisted[token]?.oneTimeDone,
        };
        writePersisted(walletAddress, persisted);
      }
    } else {
      updateRow(token, { status: "error", message: result.error || "Failed" });
    }
  };

  // For cooldown tokens, returns the seconds remaining before the user can
  // mint again. 0 means ready. For other categories, returns 0 (the
  // category-aware disabled flag below handles them).
  const cooldownSecondsLeft = (token: FaucetTokenId): number => {
    const meta = FAUCET_TOKEN_META[token];
    if (meta.category !== "cooldown" || !meta.cooldownMs) return 0;
    const last = rows[token].lastMintAt ?? 0;
    if (!last) return 0;
    const remaining = meta.cooldownMs - (Date.now() - last);
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
  };

  // True when the per-token policy says the user can't mint right now —
  // either it's a one-time token that's already funded, or it's mid-cooldown.
  const isLocked = (token: FaucetTokenId): boolean => {
    const meta = FAUCET_TOKEN_META[token];
    const row = rows[token];
    if (meta.category === "one-time" && row.status === "success") return true;
    if (meta.category === "cooldown" && cooldownSecondsLeft(token) > 0) return true;
    return false;
  };

  const mintOne = async (token: FaucetTokenId) => {
    if (!walletAddress) {
      toast.error("Connect your wallet first");
      return;
    }
    if (isLocked(token)) {
      const meta = FAUCET_TOKEN_META[token];
      if (meta.category === "one-time") {
        toast(`${meta.label} is already funded for this account`);
      } else {
        toast(`${meta.label}: wait ${cooldownSecondsLeft(token)}s before next mint`);
      }
      return;
    }
    updateRow(token, { status: "loading", message: undefined });
    const result = await runFaucet(token, walletAddress);
    applyResult(token, result);
    if (!result.ok) toast.error(`${FAUCET_TOKEN_META[token].label}: ${result.error}`);
    else toast.success(`${FAUCET_TOKEN_META[token].label} minted`);
  };

  const mintAll = async () => {
    if (!walletAddress) {
      toast.error("Connect your wallet first");
      return;
    }
    setIsMintingAll(true);
    // Skip tokens that are already locked (one-time done or mid-cooldown)
    // so "Mint All" doesn't pointlessly hit the backend with calls that
    // will only return "already funded" or rate-limit errors.
    const eligible = ALL_TOKENS.filter((t) => !isLocked(t));

    // XLM first — the account has to exist before any other tx targeting it.
    if (eligible.includes("XLM")) {
      updateRow("XLM", { status: "loading", message: undefined });
      const xlm = await runFaucet("XLM", walletAddress);
      applyResult("XLM", xlm);
    }

    // Then the three USDC mints run in parallel — each uses a different
    // backend so they don't share a rate-limit bucket.
    const remaining = eligible.filter((t) => t !== "XLM");
    remaining.forEach((t) => updateRow(t, { status: "loading", message: undefined }));
    const results = await Promise.all(
      remaining.map(async (t) => [t, await runFaucet(t, walletAddress)] as const)
    );
    for (const [t, r] of results) applyResult(t, r);

    setIsMintingAll(false);
    if (eligible.length === 0) {
      toast("Nothing to mint — all tokens are already funded or cooling down");
      return;
    }
    const failed = results.filter(([, r]) => !r.ok);
    if (failed.length === 0) toast.success("Tokens minted");
    else toast.error(`${failed.length} faucet(s) failed — see panel for details`);
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[2000] bg-black/60 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.97 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className={`fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[2001] w-[92vw] max-w-[440px] rounded-[16px] overflow-hidden ${
              isDark
                ? "bg-[#161616] border border-[#2A2A2A]"
                : "bg-white border border-[#E8E8E8]"
            }`}
            style={{
              boxShadow: isDark
                ? "0 24px 64px rgba(0,0,0,0.6), 0 0 0 0.5px rgba(255,255,255,0.04)"
                : "0 24px 64px rgba(0,0,0,0.18), 0 0 0 0.5px rgba(0,0,0,0.04)",
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Testnet token faucet"
          >
            {/* Header */}
            <div
              className={`px-5 py-4 border-b flex items-start justify-between gap-3 ${
                isDark ? "border-[#222]" : "border-[#F0F0F0]"
              }`}
            >
              <div>
                <h2
                  className={`text-[16px] font-semibold ${
                    isDark ? "text-white" : "text-[#111]"
                  }`}
                >
                  Testnet Faucet
                </h2>
                <p
                  className={`text-[12px] mt-0.5 ${
                    isDark ? "text-[#888]" : "text-[#666]"
                  }`}
                >
                  Mint test tokens used across Vanna pools
                </p>
              </div>
              <button
                onClick={onClose}
                aria-label="Close faucet"
                className={`p-1.5 rounded-md transition-colors ${
                  isDark
                    ? "text-[#999] hover:text-white hover:bg-[#222]"
                    : "text-[#666] hover:text-[#111] hover:bg-[#F2F2F2]"
                }`}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path
                    d="M3 3l8 8M11 3l-8 8"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>

            {/* Token rows */}
            <div className="p-2.5 flex flex-col gap-1.5">
              {ALL_TOKENS.map((token) => {
                const meta = FAUCET_TOKEN_META[token];
                const row = rows[token];
                const cooldown = cooldownSecondsLeft(token);
                const locked = isLocked(token);
                return (
                  <FaucetRow
                    key={token}
                    label={meta.label}
                    icon={meta.icon}
                    description={meta.description}
                    state={row}
                    isDark={isDark}
                    disabled={!walletAddress || isMintingAll || locked}
                    locked={locked}
                    cooldownSeconds={cooldown}
                    category={meta.category}
                    onMint={() => mintOne(token)}
                  />
                );
              })}
            </div>

            {/* Action footer */}
            <div
              className={`px-5 py-3 border-t flex items-center justify-between gap-3 ${
                isDark ? "border-[#222]" : "border-[#F0F0F0]"
              }`}
            >
              <p
                className={`text-[11px] ${
                  isDark ? "text-[#888]" : "text-[#666]"
                }`}
              >
                {walletAddress
                  ? "Each mint sends a tx — approve it in your wallet when prompted."
                  : "Connect wallet to use the faucet."}
              </p>
              <div className="shrink-0">
                <Button
                  size="small"
                  type="gradient"
                  text={isMintingAll ? "Minting..." : "Mint All"}
                  disabled={!walletAddress || isMintingAll}
                  onClick={mintAll}
                />
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};

interface FaucetRowProps {
  label: string;
  icon: string;
  description: string;
  state: RowState;
  isDark: boolean;
  disabled: boolean;
  /** True when policy says this token can't be re-minted right now (one-time
   * already done, or mid-cooldown). Drives the button label and color. */
  locked: boolean;
  /** Seconds remaining on a cooldown timer; only meaningful when category
   * === 'cooldown'. */
  cooldownSeconds: number;
  category: import("@/lib/faucet-utils").FaucetTokenCategory;
  onMint: () => void;
}

const FaucetRow = ({
  label,
  icon,
  description,
  state,
  isDark,
  disabled,
  locked,
  cooldownSeconds,
  category,
  onMint,
}: FaucetRowProps) => {
  const { status, message, hash } = state;

  // Subtitle: prefer error / status feedback, fall back to category hint
  // (e.g. "Cooldown · 8s" while a Soroswap mint is rate-limited).
  let subtitle: string = description;
  if (status === "loading") subtitle = "Minting...";
  else if (status === "success") {
    subtitle = hash ? `${message} · ${hash.slice(0, 8)}...${hash.slice(-4)}` : message ?? "Minted";
  } else if (status === "error") {
    subtitle = `Error: ${message}`;
  } else if (category === "cooldown" && cooldownSeconds > 0) {
    subtitle = `Cooldown · ${cooldownSeconds}s remaining`;
  }

  // Button label by state. "Funded" is terminal for one-time tokens;
  // "Wait Ns" surfaces the cooldown clock; otherwise fallback to standard
  // Mint / Retry semantics.
  let buttonText: string = "Mint";
  if (status === "loading") buttonText = "...";
  else if (locked && category === "one-time") buttonText = "Funded";
  else if (locked && category === "cooldown") buttonText = `Wait ${cooldownSeconds}s`;
  else if (status === "success") buttonText = category === "unlimited" ? "Mint" : "Done";
  else if (status === "error") buttonText = "Retry";

  return (
    <div
      className={`flex items-center gap-3 rounded-[12px] px-3 py-2.5 ${
        isDark ? "bg-[#1C1C1C]" : "bg-[#F7F7F7]"
      }`}
    >
      <div className="w-9 h-9 rounded-full overflow-hidden shrink-0 bg-white/5 flex items-center justify-center">
        <Image src={icon} alt={label} width={28} height={28} />
      </div>
      <div className="flex-1 min-w-0">
        <p
          className={`text-[13px] font-semibold leading-tight ${
            isDark ? "text-white" : "text-[#111]"
          }`}
        >
          {label}
        </p>
        <p
          className={`text-[11px] mt-0.5 truncate ${
            isDark ? "text-[#888]" : "text-[#666]"
          }`}
          title={status === "error" ? message : description}
        >
          {subtitle}
        </p>
      </div>
      <button
        onClick={onMint}
        disabled={disabled || status === "loading"}
        className={`shrink-0 text-[12px] font-semibold rounded-md px-3 py-1.5 transition-colors ${
          disabled || status === "loading"
            ? isDark
              ? "bg-[#222] text-[#555] cursor-not-allowed"
              : "bg-[#EEE] text-[#999] cursor-not-allowed"
            : status === "success"
            ? "bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25 cursor-pointer"
            : status === "error"
            ? "bg-[#FC5457]/15 text-[#FC5457] hover:bg-[#FC5457]/25 cursor-pointer"
            : isDark
            ? "bg-[#2A2A2A] text-white hover:bg-[#333] cursor-pointer"
            : "bg-[#111] text-white hover:bg-[#000] cursor-pointer"
        }`}
      >
        {buttonText}
      </button>
    </div>
  );
};
