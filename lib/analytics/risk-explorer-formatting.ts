/** HF colors aligned with analytics Risk Explorer (brand thresholds) */
export function getHFColor(hf: number): string {
  if (hf > 1.5) return "#32EEE2";
  if (hf > 1.25) return "#703AE6";
  if (hf > 1.1) return "#FF007A";
  return "#FC5457";
}
