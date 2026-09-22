'use client';

import { CHAIN_NAMES, CHAIN_COLORS } from '@/lib/risk/contracts';

interface ChainBadgeProps {
  chainId: number;
  size?: 'sm' | 'md';
}

export default function ChainBadge({ chainId, size = 'sm' }: ChainBadgeProps) {
  const name = CHAIN_NAMES[chainId] || `Chain ${chainId}`;
  const color = CHAIN_COLORS[chainId] || '#6B7280';
  const sizeClass = size === 'sm' ? 'text-[10px] px-2 py-0.5' : 'text-[11px] px-2.5 py-1';

  return (
    <span className={`inline-flex items-center rounded-full font-semibold ${sizeClass}`}
      style={{ color, backgroundColor: `${color}12` }}>
      <span className="w-1.5 h-1.5 rounded-full mr-1.5" style={{ backgroundColor: color }} />
      {name}
    </span>
  );
}
