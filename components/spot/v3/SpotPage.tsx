"use client";

/**
 * Spot screen (design prototype V3, spot.js view): the swap card (Soroswap / Aquarius inside the
 * margin account) with the "Margin account" block beside it, and Position History below. Without a
 * wallet only the swap card shows, centred, as in the design.
 */
import "./spot-v3.css";
import { useState } from "react";
import { useUserStore } from "@/store/user";
import { SwapCard } from "./SwapCard";
import { AccountPanel } from "./AccountPanel";
import { PositionsBox } from "./PositionsBox";
import type { SwapPreview } from "./swap-model";

export function SpotPage({ baseSymbol }: { baseSymbol?: string }) {
  const connected = Boolean(useUserStore((s) => s.address));
  const [preview, setPreview] = useState<SwapPreview | null>(null);

  return (
    <div className="v3">
      <div className="sp-page">
        <div className="sp-glow" aria-hidden="true">
          <i />
          <i />
        </div>
        <div className={`sp-top ${connected ? "two" : ""}`}>
          <div className="sp-cardw">
            <SwapCard baseSymbol={baseSymbol} onPreview={setPreview} />
          </div>
          {connected && <AccountPanel preview={preview} />}
        </div>
        {connected && (
          <div className="sp-col">
            <PositionsBox />
          </div>
        )}
      </div>
    </div>
  );
}
