"use client";

import { useMemo, useState } from "react";
import { formatUsd, formatPercent, cn } from "@/lib/analytics/utils";
import { riskExplorerStressPresets } from "@/lib/analytics/data/mock";
import { getHFColor } from "@/lib/analytics/risk-explorer-formatting";
import marginCalc from "@/lib/analytics/margin/calculations";
import { Card, useColors } from "./primitives";
import { useChartColors } from "@/lib/analytics/theme";
import InfoTooltip from "@/components/analytics/ui/InfoTooltip";
import { SIM_ASSETS, TOKEN_PRICES, type WalletPosition } from "./constants";
import { HEATMAP_ASSETS, LEVERAGE_RANGES, type HeatmapSelection } from "./heatmap-config";
import BadDebtMonitorSummary from "./BadDebtMonitorSummary";
import BadDebtStressHeatmap from "./BadDebtStressHeatmap";

const PAGE_SIZE = 5;

function usePagedSlice<T>(items: T[], page: number, pageSize: number) {
  return useMemo(() => {
    const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const start = (safePage - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, page, pageSize]);
}

function TablePagination({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (p: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const end = Math.min(safePage * pageSize, total);

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-t border-vgray-100 pt-4 mt-4">
      <p className="text-xs text-vgray-500 tabular-nums">
        {total === 0 ? (
          "No rows"
        ) : (
          <>
            Showing <span className="font-medium text-vgray-700">{start}</span>
            {" – "}
            <span className="font-medium text-vgray-700">{end}</span>
            {" of "}
            <span className="font-medium text-vgray-700">{total}</span>
          </>
        )}
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onPageChange(Math.max(1, safePage - 1))}
          disabled={safePage <= 1 || total === 0}
          className={cn(
            "px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors",
            safePage <= 1 || total === 0
              ? "border-vgray-100 text-vgray-300 cursor-not-allowed"
              : "border-vgray-200 text-vgray-700 hover:bg-vgray-50",
          )}
        >
          Previous
        </button>
        <span className="text-xs text-vgray-500 tabular-nums px-2">
          Page {safePage} of {totalPages}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(Math.min(totalPages, safePage + 1))}
          disabled={safePage >= totalPages || total === 0}
          className={cn(
            "px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors",
            safePage >= totalPages || total === 0
              ? "border-vgray-100 text-vgray-300 cursor-not-allowed"
              : "border-vgray-200 text-vgray-700 hover:bg-vgray-50",
          )}
        >
          Next
        </button>
      </div>
    </div>
  );
}

interface RiskExplorerProps {
  wallets: WalletPosition[];
  chainName: string;
}

function LiquidationBucket({
  title,
  color,
  totalValue,
  walletsAtRisk,
  badDebt,
  tooltip,
}: {
  title: string;
  color: string;
  totalValue: number;
  walletsAtRisk: WalletPosition[];
  badDebt?: number;
  tooltip?: string;
}) {
  const c = useColors();
  const [expanded, setExpanded] = useState(true);
  const [page, setPage] = useState(1);
  const pagedWallets = usePagedSlice(walletsAtRisk, page, PAGE_SIZE);

  return (
    <Card>
      <div className="flex items-center gap-2 mb-3">
        <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
        <h4 className={`text-sm font-bold ${c.text1}`}>{title}</h4>
        {tooltip && <InfoTooltip size="md" text={tooltip} />}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-3">
        <div>
          <p className={`text-[10px] uppercase font-semibold tracking-wide ${c.text3}`}>Value</p>
          <p className={`text-lg font-mono font-bold ${c.text1}`}>{formatUsd(totalValue)}</p>
        </div>
        <div>
          <button
            type="button"
            onClick={() => { setExpanded(!expanded); setPage(1); }}
            className={`text-[10px] uppercase font-semibold tracking-wide ${c.text3} hover:underline cursor-pointer`}
          >
            Wallets at risk {expanded ? "▴" : "▾"}
          </button>
          <p className={`text-lg font-mono font-bold ${c.text1}`}>{walletsAtRisk.length}</p>
        </div>
        {badDebt !== undefined && (
          <div>
            <p className={`text-[10px] uppercase font-semibold tracking-wide ${c.text3}`}>Bad debt</p>
            <p className="text-lg font-mono font-bold text-imperial-500">{formatUsd(badDebt)}</p>
          </div>
        )}
      </div>

      {expanded && walletsAtRisk.length > 0 && (
        <div className={`rounded-xl border overflow-hidden ${c.innerBorder}`}>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className={c.innerBg}>
                  <th className={`text-left px-3 py-2 font-semibold uppercase tracking-wide ${c.text3}`}>Wallet</th>
                  <th className={`text-left px-3 py-2 font-semibold uppercase tracking-wide ${c.text3}`}>Asset</th>
                  <th className={`text-right px-3 py-2 font-semibold uppercase tracking-wide ${c.text3}`}>Collateral</th>
                  <th className={`text-right px-3 py-2 font-semibold uppercase tracking-wide ${c.text3}`}>Debt</th>
                  <th className={`text-right px-3 py-2 font-semibold uppercase tracking-wide ${c.text3}`}>Health factor</th>
                  <th className={`text-right px-3 py-2 font-semibold uppercase tracking-wide ${c.text3}`}>Leverage</th>
                  <th className={`text-right px-3 py-2 font-semibold uppercase tracking-wide ${c.text3}`}>Bad debt</th>
                </tr>
              </thead>
              <tbody>
                {pagedWallets.map((w, i) => {
                  const walletBadDebt = w.hf < 1 ? Math.max(0, w.debt - w.collateral * 0.9) : 0;
                  return (
                    <tr key={i} className={`border-t ${c.innerBorder} ${c.hoverRow}`}>
                      <td className={`px-3 py-2 font-mono ${c.text2}`}>{w.address}</td>
                      <td className={`px-3 py-2 ${c.text2}`}>{w.primaryAsset}</td>
                      <td className={`px-3 py-2 text-right font-mono ${c.text1}`}>{formatUsd(w.collateral)}</td>
                      <td className={`px-3 py-2 text-right font-mono ${c.text1}`}>{formatUsd(w.debt)}</td>
                      <td className="px-3 py-2 text-right font-mono font-semibold" style={{ color: getHFColor(w.hf) }}>
                        {w.hf.toFixed(4)}
                      </td>
                      <td className={`px-3 py-2 text-right font-mono ${c.text2}`}>{w.leverageX.toFixed(2)}x</td>
                      <td className={`px-3 py-2 text-right font-mono ${walletBadDebt > 0 ? "text-imperial-500" : c.text3}`}>
                        {walletBadDebt > 0 ? formatUsd(walletBadDebt) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="px-3 pb-3">
            <TablePagination
              page={page}
              pageSize={PAGE_SIZE}
              total={walletsAtRisk.length}
              onPageChange={setPage}
            />
          </div>
        </div>
      )}
    </Card>
  );
}

export default function RiskExplorer({ wallets, chainName }: RiskExplorerProps) {
  const c = useColors();
  const cc = useChartColors();

  const [selectedAsset, setSelectedAsset] = useState("ETH");
  const [priceChangePct, setPriceChangePct] = useState(0);
  const [direction, setDirection] = useState<"up" | "down">("down");
  const [applied, setApplied] = useState(false);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [heatmapSelection, setHeatmapSelection] = useState<HeatmapSelection | null>(null);
  const [heatmapLeverageLabel, setHeatmapLeverageLabel] = useState<string | null>(null);

  const clearPreset = () => setActivePresetId(null);

  const clearHeatmap = () => {
    setHeatmapSelection(null);
    setHeatmapLeverageLabel(null);
  };

  const applyStressPreset = (p: (typeof riskExplorerStressPresets)[number]) => {
    setSelectedAsset(p.asset);
    setDirection(p.direction);
    setPriceChangePct(Math.min(100, Math.max(0, p.priceChangePct)));
    setApplied(true);
    setActivePresetId(p.id);
    clearHeatmap();
  };

  const onHeatmapSelectCell = (payload: {
    selection: HeatmapSelection;
    symbol: string;
    dropPct: number;
    leverageLabel: string;
  }) => {
    setSelectedAsset(payload.symbol);
    setDirection("down");
    setPriceChangePct(payload.dropPct);
    setApplied(true);
    setHeatmapSelection(payload.selection);
    setHeatmapLeverageLabel(payload.leverageLabel);
    setActivePresetId(null);
  };

  const effectivePctChange = direction === "down" ? -Math.abs(priceChangePct) : Math.abs(priceChangePct);
  const currentPrice = TOKEN_PRICES[selectedAsset] ?? 1;
  const projectedPrice = currentPrice * (1 + effectivePctChange / 100);

  const { eligible, atRisk } = useMemo(() => {
    const priceMultiplier = applied ? 1 + effectivePctChange / 100 : 1;

    const simulated = wallets.map((w) => {
      let applyShock = false;
      if (applied) {
        if (heatmapSelection) {
          const ha = HEATMAP_ASSETS[heatmapSelection.assetTabIndex];
          const lev = LEVERAGE_RANGES[heatmapSelection.row];
          applyShock =
            ha.matchFn(w) && w.leverageX >= lev.min && w.leverageX < lev.max;
        } else {
          applyShock =
            w.primaryAsset === selectedAsset || w.primaryAsset === "W" + selectedAsset;
        }
      }
      const adjustedCollateral = applyShock ? w.collateral * priceMultiplier : w.collateral;
      const newHF = marginCalc.calcHF(adjustedCollateral, w.debt);
      const newLeverage = marginCalc.calcLeverage(adjustedCollateral, w.debt);

      return {
        ...w,
        collateral: adjustedCollateral,
        hf: newHF,
        leverageX: newLeverage,
      };
    });

    const eligibleList: WalletPosition[] = [];
    const atRiskList: WalletPosition[] = [];

    for (const w of simulated) {
      if (w.hf < 1.0) {
        eligibleList.push(w);
      } else if (w.hf < 1.2) {
        atRiskList.push(w);
      }
    }

    return { eligible: eligibleList, atRisk: atRiskList };
  }, [wallets, selectedAsset, effectivePctChange, applied, heatmapSelection]);

  const eligibleValue = eligible.reduce((s, w) => s + w.collateral, 0);
  const eligibleBadDebt = eligible.reduce((s, w) => s + Math.max(0, w.debt - w.collateral * 0.9), 0);
  const atRiskValue = atRisk.reduce((s, w) => s + w.collateral, 0);

  const handleApply = () => {
    setApplied(true);
  };

  const handleCancel = () => {
    setApplied(false);
    setPriceChangePct(0);
    setActivePresetId(null);
    clearHeatmap();
  };

  const onManualChange = () => {
    setApplied(false);
    clearPreset();
    clearHeatmap();
  };

  return (
    <div className="space-y-8">
      <p className="text-sm text-vgray-500">
        Baseline bad debt, stress heatmap, and manual shocks for{" "}
        <span className="font-medium text-vgray-700">{chainName}</span>
      </p>

      <BadDebtMonitorSummary wallets={wallets} />

      <Card>
        <div className="flex items-center gap-1.5">
          <h2 className={`text-sm font-bold ${c.text1}`}>Stress test heatmap</h2>
          <InfoTooltip size="md" text="Simulates bad debt under different price drops and leverage bands. Green cells mean no bad debt, red cells show potential losses. Click any cell to load that scenario." />
        </div>
        <p className={`text-xs mt-1 mb-1 ${c.text3}`}>
          Bad debt by leverage row and price drop (baseline math). Click a cell to load that scenario — simulator
          applies the shock only to wallets in that asset tab and leverage band.
        </p>
        <BadDebtStressHeatmap
          wallets={wallets}
          selectedCell={heatmapSelection}
          onSelectCell={onHeatmapSelectCell}
        />
      </Card>

      <Card className="mb-4">
        <div className="mb-4 pb-4 border-b border-vgray-100">
          <p className={`text-[10px] font-semibold uppercase tracking-wide ${c.text3} mb-2`}>
            Preset stress tests
          </p>
          <p className={`text-xs ${c.text3} mb-3`}>
            Named scenarios fill the controls below and run on all wallets holding that collateral (no leverage filter).
          </p>
          <div className="flex flex-wrap gap-2">
            {riskExplorerStressPresets.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => applyStressPreset(p)}
                title={p.description}
                className={cn(
                  "px-3 py-2 rounded-lg text-xs font-semibold transition-all border",
                  activePresetId === p.id
                    ? "bg-violet-600 text-white border-violet-600 shadow-sm"
                    : "bg-base-platinum text-vgray-700 border-vgray-200 hover:border-violet-300"
                )}
              >
                {p.name}
              </button>
            ))}
          </div>
          {activePresetId && (
            <p className={`text-xs mt-3 ${c.text3} leading-relaxed`}>
              {riskExplorerStressPresets.find((p) => p.id === activePresetId)?.description}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label className={`text-[10px] font-semibold uppercase tracking-wide ${c.text3}`}>Asset</label>
            <select
              value={selectedAsset}
              onChange={(e) => {
                setSelectedAsset(e.target.value);
                onManualChange();
              }}
              className={`rounded-lg px-3 py-2 text-sm font-mono border ${c.inputBg} ${c.text1} outline-none`}
            >
              {SIM_ASSETS.map((a) => (
                <option key={a.symbol} value={a.symbol}>
                  {a.icon} {a.symbol}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className={`text-[10px] font-semibold uppercase tracking-wide ${c.text3}`}>Price change %</label>
            <input
              type="number"
              min={0}
              max={100}
              value={priceChangePct}
              onChange={(e) => {
                setPriceChangePct(Math.max(0, Math.min(100, Number(e.target.value))));
                onManualChange();
              }}
              className={`rounded-lg px-3 py-2 text-sm font-mono border w-24 ${c.inputBg} ${c.text1} outline-none`}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className={`text-[10px] font-semibold uppercase tracking-wide ${c.text3}`}>Direction</label>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => {
                  setDirection("up");
                  onManualChange();
                }}
                className={`px-3 py-2 rounded-lg text-sm font-semibold border transition-colors ${
                  direction === "up"
                    ? "bg-electric-500/15 text-electric-700 border-electric-500/30"
                    : `${c.inputBg} ${c.text3}`
                }`}
              >
                ▲ Up
              </button>
              <button
                type="button"
                onClick={() => {
                  setDirection("down");
                  onManualChange();
                }}
                className={`px-3 py-2 rounded-lg text-sm font-semibold border transition-colors ${
                  direction === "down"
                    ? "bg-imperial-500/15 text-imperial-600 border-imperial-500/30"
                    : `${c.inputBg} ${c.text3}`
                }`}
              >
                ▼ Down
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className={`text-[10px] font-semibold uppercase tracking-wide ${c.text3}`}>Current price</label>
            <p className={`text-sm font-mono font-bold ${c.text1}`}>{formatUsd(currentPrice)}</p>
          </div>
          <div className="flex flex-col gap-1">
            <label className={`text-[10px] font-semibold uppercase tracking-wide ${c.text3}`}>Projected price</label>
            <p
              className="text-sm font-mono font-bold"
              style={{ color: effectivePctChange >= 0 ? cc.electric : cc.imperial }}
            >
              {formatUsd(projectedPrice)}
            </p>
          </div>

          <div className="flex gap-2 ml-auto">
            <button
              type="button"
              onClick={handleApply}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-violet-600 text-white hover:bg-violet-700 transition-colors"
            >
              Apply
            </button>
            <button
              type="button"
              onClick={handleCancel}
              className={`px-4 py-2 rounded-lg text-sm font-semibold border ${c.inputBg} ${c.text2} hover:opacity-80 transition-colors`}
            >
              Cancel
            </button>
          </div>
        </div>

        {applied && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-violet-500/10 border border-violet-500/20">
              <div className="w-2 h-2 rounded-full bg-violet-500 animate-pulse" />
              <span className="text-[11px] font-semibold text-violet-700">Simulation active</span>
              <span className={`text-[11px] font-mono ${c.text3}`}>
                {selectedAsset} {effectivePctChange >= 0 ? "+" : ""}
                {effectivePctChange.toFixed(1)}%
              </span>
            </div>
            {heatmapSelection && heatmapLeverageLabel && (
              <span className={`text-[11px] ${c.text3}`}>
                Heatmap: leverage {heatmapLeverageLabel} · shock only on matching wallets
              </span>
            )}
            {!heatmapSelection && activePresetId === null && (
              <span className={`text-[11px] ${c.text3}`}>Manual: all wallets with this collateral</span>
            )}
          </div>
        )}
      </Card>

      <div className="space-y-4">
        <LiquidationBucket
          title="Eligible for liquidations"
          color={cc.imperial}
          totalValue={eligibleValue}
          walletsAtRisk={eligible}
          badDebt={eligibleBadDebt}
          tooltip="Positions with HF below 1.0 under this stress scenario — these would be liquidated immediately. Bad debt shows the shortfall if collateral can't cover the loan."
        />
        <LiquidationBucket
          title="Risk for liquidations"
          color={cc.rose}
          totalValue={atRiskValue}
          walletsAtRisk={atRisk}
          tooltip="Positions with HF between 1.0-1.2 under this stress scenario — not yet liquidatable but dangerously close. A further small price drop would push them into liquidation."
        />
      </div>
    </div>
  );
}
