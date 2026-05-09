"use client";

import { useEffect, useMemo, useState } from "react";
import { formatUsd, formatPercent, cn } from "@/lib/analytics/utils";
import marginCalc from "@/lib/analytics/margin/calculations";
import type { WalletPosition } from "./constants";
import { HEATMAP_ASSETS, LEVERAGE_RANGES, type HeatmapSelection } from "./heatmap-config";
import { useColors } from "./primitives";
import { useChartColors } from "@/lib/analytics/theme";

interface HeatmapCell {
  badDebt: number;
  liquidatedCount: number;
  totalWallets: number;
}

type Props = {
  wallets: WalletPosition[];
  selectedCell: HeatmapSelection | null;
  onSelectCell: (payload: {
    selection: HeatmapSelection;
    symbol: string;
    dropPct: number;
    leverageLabel: string;
  }) => void;
};

export default function BadDebtStressHeatmap({
  wallets,
  selectedCell,
  onSelectCell,
}: Props) {
  const c = useColors();
  const cc = useChartColors();
  const [activeAsset, setActiveAsset] = useState(0);
  /** Which cell’s detail panel is open — set on click only */
  const [detailCell, setDetailCell] = useState<{ row: number; col: number } | null>(null);

  useEffect(() => {
    if (selectedCell) setActiveAsset(selectedCell.assetTabIndex);
  }, [selectedCell]);

  useEffect(() => {
    if (!selectedCell) setDetailCell(null);
  }, [selectedCell]);

  const asset = HEATMAP_ASSETS[activeAsset];

  const totalTVL = useMemo(
    () => wallets.reduce((sum, w) => sum + w.collateral, 0),
    [wallets]
  );

  const grid = useMemo(() => {
    const matchingWallets = wallets.filter(asset.matchFn);
    const result: HeatmapCell[][] = [];

    for (const levRange of LEVERAGE_RANGES) {
      const row: HeatmapCell[] = [];
      const rangeWallets = matchingWallets.filter(
        (w) => w.leverageX >= levRange.min && w.leverageX < levRange.max
      );

      for (const drop of asset.drops) {
        let badDebt = 0;
        let liquidatedCount = 0;

        for (const w of rangeWallets) {
          const dropFactor = 1 + drop / 100;
          const newCollateral = w.collateral * dropFactor;
          const newHF = marginCalc.calcHF(newCollateral, w.debt);

          if (newHF < 1) {
            liquidatedCount++;
            const shortfall = w.debt - newCollateral * 0.9;
            if (shortfall > 0) badDebt += shortfall;
          }
        }

        row.push({ badDebt, liquidatedCount, totalWallets: rangeWallets.length });
      }
      result.push(row);
    }
    return result;
  }, [wallets, asset]);

  const maxBadDebt = useMemo(() => {
    let max = 0;
    for (const row of grid) {
      for (const cell of row) {
        if (cell.badDebt > max) max = cell.badDebt;
      }
    }
    return max;
  }, [grid]);

  function getCellColor(badDebt: number): string {
    if (badDebt === 0) {
      return cc.electric === "#32EEE2"
        ? "rgba(50, 238, 226, 0.15)"
        : "rgba(16, 185, 129, 0.15)";
    }
    const intensity = maxBadDebt > 0 ? Math.min(badDebt / maxBadDebt, 1) : 0;
    return cc.imperial === "#FC5457"
      ? `rgba(252, 84, 87, ${0.12 + intensity * 0.5})`
      : `rgba(239, 68, 68, ${0.12 + intensity * 0.5})`;
  }

  const detailData =
    detailCell !== null ? grid[detailCell.row]?.[detailCell.col] : null;
  const detailDrop =
    detailCell !== null ? asset.drops[detailCell.col] : null;
  const detailLev =
    detailCell !== null ? LEVERAGE_RANGES[detailCell.row] : null;

  const cellSelected = (ri: number, ci: number) =>
    selectedCell?.assetTabIndex === activeAsset &&
    selectedCell.row === ri &&
    selectedCell.col === ci;

  return (
    <div className="mt-2">
      <div className="flex gap-1.5 mb-4 flex-wrap">
        {HEATMAP_ASSETS.map((a, i) => (
          <button
            key={a.symbol}
            type="button"
            onClick={() => {
              setActiveAsset(i);
              setDetailCell(null);
            }}
            className={cn(
              "px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all border",
              i === activeAsset
                ? "bg-violet-500/15 text-violet-700 border-violet-500/30"
                : "bg-base-platinum text-vgray-600 border-vgray-200 hover:border-violet-300"
            )}
          >
            {a.label}
          </button>
        ))}
      </div>

      <p className={`text-xs ${c.text3} mb-3`}>
        Click a cell to see bucket details here and load that scenario in the simulator above.
      </p>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[10px]">
          <thead>
            <tr>
              <th className={`text-left px-2 py-1.5 font-semibold ${c.text3}`}>Leverage</th>
              {asset.drops.map((d) => (
                <th key={d} className={`px-2 py-1.5 font-semibold text-center ${c.text3}`}>
                  {d}%
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {LEVERAGE_RANGES.map((lev, ri) => (
              <tr key={lev.label}>
                <td className={`px-2 py-1.5 font-semibold ${c.text2}`}>{lev.label}</td>
                {asset.drops.map((drop, ci) => {
                  const cell = grid[ri]?.[ci];
                  const isDetail = detailCell?.row === ri && detailCell?.col === ci;
                  const isSel = cellSelected(ri, ci);
                  return (
                    <td key={ci} className="px-1 py-1 text-center">
                      <button
                        type="button"
                        onClick={() => {
                          setDetailCell({ row: ri, col: ci });
                          onSelectCell({
                            selection: { assetTabIndex: activeAsset, row: ri, col: ci },
                            symbol: asset.symbol,
                            dropPct: Math.abs(drop),
                            leverageLabel: lev.label,
                          });
                        }}
                        className={cn(
                          "rounded-md px-1.5 py-2 transition-all text-[9px] font-mono font-bold w-full min-w-[52px]",
                          (isDetail || isSel) && "ring-2 ring-violet-600 ring-offset-1 scale-[1.02]"
                        )}
                        style={{
                          backgroundColor: getCellColor(cell?.badDebt ?? 0),
                          color: cell?.badDebt === 0 ? cc.electric : (cc.imperial === "#FC5457" ? "#FC5457" : "#fca5a5"),
                        }}
                      >
                        {cell?.badDebt === 0 ? "—" : formatUsd(cell?.badDebt ?? 0)}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detailData && detailDrop !== null && detailLev && (
        <div className={`mt-3 rounded-xl border border-vgray-100 bg-base-platinum p-3.5 text-xs`}>
          <div className={`font-bold ${c.text1} mb-2`}>
            {asset.label} {detailDrop}% · Leverage {detailLev.label}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <span className={c.text3}>Bad debt</span>
              <div
                className={cn(
                  "font-bold mt-0.5",
                  detailData.badDebt > 0 ? "text-imperial-600" : "text-electric-700"
                )}
              >
                {formatUsd(detailData.badDebt)}
              </div>
            </div>
            <div>
              <span className={c.text3}>Liquidated</span>
              <div className={`font-bold mt-0.5 ${c.text1}`}>
                {detailData.liquidatedCount} / {detailData.totalWallets}
              </div>
            </div>
            <div>
              <span className={c.text3}>Impact (% TVL)</span>
              <div className={`font-bold mt-0.5 ${c.text1}`}>
                {totalTVL > 0
                  ? formatPercent((detailData.badDebt / totalTVL) * 100)
                  : "0.0%"}
              </div>
            </div>
            <div>
              <span className={c.text3}>Note</span>
              <div className={`mt-0.5 ${c.text2} leading-snug`}>
                {detailData.badDebt === 0
                  ? "No bad debt in this bucket for this shock."
                  : "Scenario loaded in the simulator above."}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 mt-4 flex-wrap">
        <span className={`text-[10px] font-semibold ${c.text3}`}>Legend:</span>
        <div className="flex items-center gap-1.5">
          <div className="w-4 h-3 rounded-sm" style={{ backgroundColor: getCellColor(0) }} />
          <span className={`text-[10px] ${c.text3}`}>No bad debt</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-4 h-3 rounded-sm" style={{ backgroundColor: cc.imperial === "#FC5457" ? "rgba(252, 84, 87, 0.4)" : "rgba(239, 68, 68, 0.4)" }} />
          <span className={`text-[10px] ${c.text3}`}>Higher bad debt</span>
        </div>
      </div>
    </div>
  );
}
