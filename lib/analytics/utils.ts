import { type RiskStatus } from "@/lib/analytics/data/mock";

export function formatUsd(value: number): string {
  if (Math.abs(value) >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

export function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function formatTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function formatTimeAgo(timestamp: number): string {
  const diff = (Date.now() - timestamp) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function statusColor(status: RiskStatus): string {
  switch (status) {
    case "healthy": return "#32EEE2";
    case "warning": return "#F59E0B";
    case "danger": return "#FF007A";
    case "critical": return "#FC5457";
    default: return "#949494";
  }
}

export function statusBg(status: RiskStatus): string {
  switch (status) {
    case "healthy": return "bg-electric-500";
    case "warning": return "bg-amber-500";
    case "danger": return "bg-rose-500";
    case "critical": return "bg-imperial-500";
    default: return "bg-vgray-400";
  }
}

export function statusBgLight(status: RiskStatus): string {
  switch (status) {
    case "healthy": return "bg-electric-50";
    case "warning": return "bg-amber-400/10";
    case "danger": return "bg-rose-50";
    case "critical": return "bg-imperial-50";
    default: return "bg-vgray-50";
  }
}

export function statusTextColor(status: RiskStatus): string {
  switch (status) {
    case "healthy": return "text-electric-700";
    case "warning": return "text-amber-600";
    case "danger": return "text-rose-600";
    case "critical": return "text-imperial-600";
    default: return "text-vgray-500";
  }
}

export function hfColor(hf: number): string {
  if (hf < 1.0) return "#FC5457";
  if (hf < 1.1) return "#FF007A";
  if (hf < 1.3) return "#F59E0B";
  if (hf < 1.5) return "#9F7BEE";
  if (hf < 2.0) return "#703AE6";
  return "#32EEE2";
}

export function hfBandColor(range: string): string {
  if (range.includes("< 1.0")) return "#FC5457";
  if (range.includes("1.0")) return "#FF007A";
  if (range.includes("1.1")) return "#F59E0B";
  if (range.includes("1.3")) return "#9F7BEE";
  if (range.includes("1.5")) return "#703AE6";
  return "#32EEE2";
}

export function leverageColor(range: string): string {
  const num = parseInt(range);
  if (num >= 9) return "#FC5457";
  if (num >= 7) return "#FF007A";
  if (num >= 5) return "#F59E0B";
  if (num >= 3) return "#9F7BEE";
  return "#32EEE2";
}

export function cn(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(" ");
}
