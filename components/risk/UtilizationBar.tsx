'use client';

import { useTheme } from '@/contexts/theme-context';

interface UtilizationBarProps {
  value: number;
  label?: string;
  showPercent?: boolean;
  height?: number;
}

export default function UtilizationBar({ value, label, showPercent = true, height = 6 }: UtilizationBarProps) {
  const { isDark } = useTheme();
  const clamped = Math.min(Math.max(value, 0), 100);

  const barColor =
    clamped > 90 ? '#FC5457' :
    clamped > 75 ? '#FF007A' :
    clamped > 50 ? '#703AE6' :
    '#32EEE2';

  return (
    <div className="w-full">
      {(label || showPercent) && (
        <div className="flex justify-between items-center mb-1.5">
          {label && <span className={`text-[11px] font-semibold uppercase tracking-wide ${isDark ? 'text-[#6B7280]' : 'text-[#9CA3AF]'}`}>{label}</span>}
          {showPercent && <span className={`text-[11px] font-mono font-semibold ${isDark ? 'text-[#D1D5DB]' : 'text-[#1F1F1F]'}`}>{clamped.toFixed(1)}%</span>}
        </div>
      )}
      <div className={`w-full rounded-full ${isDark ? 'bg-[#1E1E26]' : 'bg-[#F3F4F6]'}`} style={{ height }}>
        <div className="rounded-full transition-all duration-500" style={{ width: `${clamped}%`, height, backgroundColor: barColor }} />
      </div>
    </div>
  );
}
