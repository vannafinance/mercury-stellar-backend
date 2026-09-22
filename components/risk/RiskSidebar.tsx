'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV_ITEMS = [
  { href: '/risk', label: 'Overview', icon: '📊' },
  { href: '/risk/liquidations', label: 'Liquidations', icon: '⚠️' },
  { href: '/risk/markets', label: 'Markets', icon: '🏦' },
  { href: '/risk/rates', label: 'Interest Rates', icon: '📈' },
  { href: '/risk/oracle', label: 'Oracle Health', icon: '🔮' },
  { href: '/risk/user', label: 'My Position', icon: '👤' },
  { href: '/risk/simulator', label: 'Risk Simulator', icon: '🎯' },
];

export default function RiskSidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-56 shrink-0 border-r border-white/[0.06] bg-black/30 backdrop-blur-sm hidden lg:block">
      <div className="p-4">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">Risk Analytics</h2>
        <nav className="space-y-1">
          {NAV_ITEMS.map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'bg-white/[0.08] text-white font-medium'
                    : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'
                }`}
              >
                <span className="text-base">{item.icon}</span>
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </aside>
  );
}
