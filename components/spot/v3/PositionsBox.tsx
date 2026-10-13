"use client";

/**
 * Spot's Position History (V3 design): the margin account's swaps, reconstructed from on-chain
 * events by lib/spot-history.ts (RPC + Mercury, merged by tx hash). Same query key the Portfolio
 * Spot tab and the margin-account hydrator use, so the swap card's post-tx invalidations refresh
 * it. Account holdings stay on the Margin page.
 */
import { useQuery } from "@tanstack/react-query";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { getSpotHistory } from "@/lib/spot-history";
import { Icon } from "@/components/v3/icons";
import { timeFmt, tokFmt } from "@/components/v3/format";
import { VannaLoader } from "@/components/v3/vanna-loader";

const VIA: Record<string, { label: string; sym: string }> = {
  soroswap: { label: "Soroswap", sym: "SOROSWAP" },
  aquarius: { label: "Aquarius", sym: "AQUARIUS" },
};

/** Spot shows swap history only; account holdings stay on the Margin page. */
export function PositionsBox() {
  const marginAccountAddress = useMarginAccountInfoStore((s) => s.marginAccountAddress);
  const { data: swaps = [], isLoading, error } = useQuery({
    queryKey: ["spot", "history", marginAccountAddress ?? null],
    queryFn: () => getSpotHistory(marginAccountAddress),
    enabled: Boolean(marginAccountAddress),
    staleTime: 4_000,
    refetchOnMount: "always",
  });
  const loading = Boolean(marginAccountAddress) && isLoading;

  return (
    <section className="sp-box" aria-label="Spot position history">
      <div className="sp-bh">
        <span className="sp-bt">Position History{swaps.length > 0 && <small className="num">{swaps.length}</small>}</span>
        <span className="sp-bs">
          {swaps.length} {swaps.length === 1 ? "swap" : "swaps"} · via Soroswap / Aquarius
        </span>
      </div>
      {swaps.length ? (
        <div>
          <div className="sp-hh c5">
            <span>Time</span>
            <span>Paid</span>
            <span>Received</span>
            <span>Swap via</span>
            <span className="r">Tx</span>
          </div>
          {swaps.map((r) => {
            const via = VIA[r.protocol];
            return (
              <div key={r.id} className="sp-hr c5 num">
                <span className="mut" data-l="Time">
                  {timeFmt(Math.floor(r.timestamp / 1000))}
                </span>
                <span className="sp-hc" data-l="Paid">
                  <Icon sym={r.tokenIn} className="sp-ico s20" />
                  <span className="sp-neg">−{tokFmt(Number(r.amountIn), r.tokenIn, false)}</span> {r.tokenIn}
                </span>
                <span className="sp-hc" data-l="Received">
                  <Icon sym={r.tokenOut} className="sp-ico s20" />
                  <span className="sp-pos">+{tokFmt(Number(r.amountOut), r.tokenOut, false)}</span> {r.tokenOut}
                </span>
                <span className="sp-hc" data-l="Swap via">
                  {via ? (
                    <>
                      <Icon sym={via.sym} className="sp-ico s16" />
                      {via.label}
                    </>
                  ) : (
                    "N/A"
                  )}
                </span>
                <span className="r" data-l="Tx">
                  <a className="sp-tx" href={`https://stellar.expert/explorer/testnet/tx/${r.txHash}`} target="_blank" rel="noopener noreferrer">
                    {r.txHash.slice(0, 4)}…{r.txHash.slice(-4)}
                  </a>
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="sp-empty">{loading ? <VannaLoader label="Loading swaps" /> : error ? "Unable to load position history. Please try again." : "No swaps yet"}</div>
      )}
    </section>
  );
}
