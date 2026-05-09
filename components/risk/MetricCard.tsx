'use client';

import { useTheme } from '@/contexts/theme-context';

interface MetricCardProps {
  title: string;
  value: string;
  subtitle?: string;
  change?: string;
  changePositive?: boolean;
  icon?: React.ReactNode;
  loading?: boolean;
  accent?: boolean;
}

export default function MetricCard({ title, value, subtitle, change, changePositive, icon, loading, accent }: MetricCardProps) {
  const { isDark } = useTheme();

  return (
    <div className={`rounded-2xl p-5 transition-all duration-200 border ${
      accent
        ? isDark
          ? 'bg-gradient-to-br from-[#703AE6]/10 to-[#FF007A]/5 border-[#703AE6]/20'
          : 'bg-gradient-to-br from-[#703AE6]/5 to-[#FF007A]/3 border-[#703AE6]/15'
        : isDark
          ? 'bg-[#141419] border-[#1E1E26]'
          : 'bg-white border-[#E5E7EB]'
    } ${isDark ? 'hover:border-[#2a2a36]' : 'hover:border-[#D1D5DB]'}`}>
      <div className="flex items-start justify-between">
        <div className="space-y-1.5">
          <p className={`text-[11px] font-semibold uppercase tracking-widest ${isDark ? 'text-[#6B7280]' : 'text-[#9CA3AF]'}`}>{title}</p>
          {loading ? (
            <div className={`h-8 w-28 rounded-lg animate-pulse ${isDark ? 'bg-[#1E1E26]' : 'bg-[#F3F4F6]'}`} />
          ) : (
            <p className={`text-[22px] font-bold font-mono tracking-tight ${isDark ? 'text-[#F9FAFB]' : 'text-[#1F1F1F]'}`}>{value}</p>
          )}
          {subtitle && <p className={`text-[11px] ${isDark ? 'text-[#4B5563]' : 'text-[#9CA3AF]'}`}>{subtitle}</p>}
          {change && (
            <p className={`text-[11px] font-mono font-semibold ${changePositive ? 'text-[#32EEE2]' : 'text-[#FC5457]'}`}>
              {change}
            </p>
          )}
        </div>
        {icon && <div className={isDark ? 'text-[#4B5563]' : 'text-[#9CA3AF]'}>{icon}</div>}
      </div>
    </div>
  );
}
