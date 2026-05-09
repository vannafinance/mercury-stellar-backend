'use client';

import { useTheme } from '@/contexts/theme-context';
import { getHFColor } from '@/lib/risk/formatting';

interface HealthFactorGaugeProps {
  value: number;
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
}

export default function HealthFactorGauge({ value, size = 'md', showLabel = true }: HealthFactorGaugeProps) {
  const { isDark } = useTheme();
  const color = getHFColor(value);
  const displayValue = !isFinite(value) ? '\u221E' : value.toFixed(2);

  const sizes = {
    sm: { ring: 60, stroke: 4, text: 'text-sm', label: 'text-[10px]' },
    md: { ring: 100, stroke: 5, text: 'text-xl', label: 'text-xs' },
    lg: { ring: 150, stroke: 7, text: 'text-3xl', label: 'text-sm' },
  };

  const s = sizes[size];
  const radius = (s.ring - s.stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.min(isFinite(value) ? value / 2 : 1, 1);
  const offset = circumference * (1 - progress);

  return (
    <div className="flex flex-col items-center">
      <svg width={s.ring} height={s.ring} className="-rotate-90">
        <circle cx={s.ring / 2} cy={s.ring / 2} r={radius}
          fill="none" stroke={isDark ? '#1E1E26' : '#E5E7EB'} strokeWidth={s.stroke} />
        <circle cx={s.ring / 2} cy={s.ring / 2} r={radius}
          fill="none" stroke={color} strokeWidth={s.stroke}
          strokeDasharray={circumference} strokeDashoffset={offset}
          strokeLinecap="round" className="transition-all duration-700"
          style={{ filter: `drop-shadow(0 0 8px ${color}50)` }} />
      </svg>
      <div className="absolute flex flex-col items-center justify-center" style={{ width: s.ring, height: s.ring }}>
        <span className={`${s.text} font-mono font-bold`} style={{ color }}>{displayValue}</span>
        {showLabel && <span className={`${s.label} ${isDark ? 'text-[#6B7280]' : 'text-[#9CA3AF]'}`}>Health Factor</span>}
      </div>
    </div>
  );
}
