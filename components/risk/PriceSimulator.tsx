'use client';

import { useState, useMemo } from 'react';
import { useTheme } from '@/contexts/theme-context';
import marginCalc from '@/lib/utils/margin/calculations';
import { formatUSD, formatHF, getHFBgClass } from '@/lib/risk/formatting';

interface PriceSimulatorProps {
  collateralUsd: number;
  debtUsd: number;
  ethCollateralPortion: number;
}

export default function PriceSimulator({ collateralUsd, debtUsd, ethCollateralPortion }: PriceSimulatorProps) {
  const { isDark } = useTheme();
  const [ethChange, setEthChange] = useState(0);

  const simulation = useMemo(() => {
    const ethColl = collateralUsd * ethCollateralPortion;
    const stableColl = collateralUsd * (1 - ethCollateralPortion);
    const newColl = stableColl + ethColl * (1 + ethChange / 100);
    const newHF = marginCalc.calcHF(newColl, debtUsd);
    const newLTV = marginCalc.calcLTV(newColl, debtUsd);
    return { newCollateral: newColl, newHF, newLTV, hfStatus: marginCalc.getHFStatus(newHF), isLiquidatable: newHF <= 1.0 };
  }, [collateralUsd, debtUsd, ethCollateralPortion, ethChange]);

  const cardBg = isDark ? 'bg-[#141419] border-[#1E1E26]' : 'bg-white border-[#E5E7EB]';
  const inputBg = isDark ? 'bg-[#0D0D12]' : 'bg-[#F7F7F7]';
  const mutedText = isDark ? 'text-[#6B7280]' : 'text-[#9CA3AF]';

  return (
    <div className={`rounded-2xl border p-5 ${cardBg}`}>
      <h3 className={`text-sm font-semibold mb-1 ${isDark ? 'text-[#F9FAFB]' : 'text-[#1F1F1F]'}`}>Price Impact Simulator</h3>
      <p className={`text-[11px] ${mutedText} mb-5`}>What happens if ETH price changes?</p>
      <div className="space-y-4">
        <div>
          <div className="flex justify-between text-[11px] mb-1.5">
            <span className={`${mutedText} font-semibold`}>ETH Price Change</span>
            <span className={`font-mono font-bold ${ethChange >= 0 ? 'text-[#32EEE2]' : 'text-[#FC5457]'}`}>{ethChange >= 0 ? '+' : ''}{ethChange}%</span>
          </div>
          <input type="range" min={-80} max={100} value={ethChange} onChange={e => setEthChange(Number(e.target.value))} className="w-full accent-[#703AE6]" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className={`rounded-xl p-3 ${inputBg}`}>
            <p className={`text-[10px] ${mutedText} uppercase font-semibold`}>New Collateral</p>
            <p className={`text-sm font-mono font-bold mt-1 ${isDark ? 'text-[#F9FAFB]' : 'text-[#1F1F1F]'}`}>{formatUSD(simulation.newCollateral)}</p>
          </div>
          <div className={`rounded-xl p-3 border ${getHFBgClass(simulation.newHF)}`}>
            <p className="text-[10px] uppercase font-semibold opacity-70">New HF</p>
            <p className="text-sm font-mono font-bold mt-1">{formatHF(simulation.newHF)}</p>
          </div>
        </div>
        {simulation.isLiquidatable && (
          <div className="rounded-xl bg-[#FC5457]/8 border border-[#FC5457]/20 p-3 text-center">
            <p className="text-[#FC5457] text-sm font-semibold">Position would be liquidated!</p>
          </div>
        )}
      </div>
    </div>
  );
}
