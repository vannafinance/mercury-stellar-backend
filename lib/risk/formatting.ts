export function getHFColor(value: number): string {
  if (!Number.isFinite(value)) return "#32EEE2";
  if (value < 1) return "#FC5457";
  if (value < 1.1) return "#F59E0B";
  if (value < 1.3) return "#FBBF24";
  return "#32EEE2";
}

export function formatUSD(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

export function formatHF(hf: number): string {
  return !Number.isFinite(hf) ? "∞" : hf.toFixed(2);
}

export function getHFBgClass(hf: number): string {
  if (!Number.isFinite(hf)) return "border-emerald-500/30 bg-emerald-500/10";
  if (hf < 1) return "border-red-500/30 bg-red-500/10";
  if (hf < 1.1) return "border-amber-500/30 bg-amber-500/10";
  return "border-emerald-500/30 bg-emerald-500/10";
}
