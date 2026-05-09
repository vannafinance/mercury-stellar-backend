'use client';

import { useState } from 'react';
import { SUPPORTED_CHAINS, CHAIN_NAMES } from '@/lib/risk/contracts';

interface RiskHeaderProps {
  title: string;
  subtitle?: string;
  selectedChain: number | null;
  onChainChange: (chainId: number | null) => void;
}

export default function RiskHeader({ title, subtitle, selectedChain, onChainChange }: RiskHeaderProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-6">
      <div>
        <h1 className="text-xl font-semibold text-white">{title}</h1>
        {subtitle && <p className="text-sm text-gray-400 mt-0.5">{subtitle}</p>}
      </div>
      <div className="relative">
        <button
          onClick={() => setOpen(!open)}
          className="px-3 py-1.5 rounded-lg border border-white/[0.1] bg-white/[0.03] text-sm text-gray-300 hover:border-white/[0.2] transition-colors"
        >
          {selectedChain ? CHAIN_NAMES[selectedChain] : 'All Chains'} ▾
        </button>
        {open && (
          <div className="absolute right-0 top-full mt-1 w-36 rounded-lg border border-white/[0.1] bg-[#111118] shadow-xl z-50">
            <button
              onClick={() => { onChainChange(null); setOpen(false); }}
              className={`block w-full text-left px-3 py-2 text-sm ${!selectedChain ? 'text-white bg-white/[0.06]' : 'text-gray-400 hover:text-white'}`}
            >
              All Chains
            </button>
            {SUPPORTED_CHAINS.map((id) => (
              <button
                key={id}
                onClick={() => { onChainChange(id); setOpen(false); }}
                className={`block w-full text-left px-3 py-2 text-sm ${selectedChain === id ? 'text-white bg-white/[0.06]' : 'text-gray-400 hover:text-white'}`}
              >
                {CHAIN_NAMES[id]}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
