/** Short human label for assistant chrome — avoids truncating "/margin" to "reading /". */
export function assistantPageLabel(pathname: string | null | undefined): string {
  const raw = (pathname || "/").split("?")[0] || "/";
  if (raw === "/" || raw === "") return "Home";
  const seg = raw.split("/").filter(Boolean).pop() || "page";
  if (seg === "spot") return "Spot trade";
  return seg
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
