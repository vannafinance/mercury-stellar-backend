/**
 * Figures the way a person reads them, for text that arrives from the protocol with the contract's full precision.
 *
 * 24 Oct, N3: a refusal quoted "($996.397732626120418858 USD)". Dollar amounts are shown to the cent; any other decimal with more
 * places than a Stellar token has (7) is cut to 7 with trailing zeros dropped. Presentation only: it never changes which amount a
 * step carries, and it leaves hashes, addresses, whole numbers and short figures exactly as written.
 */
const THOUSANDS = (whole: string) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function tidyFigures(text: string): string {
  return text
    // Money: $ then a decimal with more than two places.
    .replace(/\$(\d[\d,]*)\.(\d{3,})/g, (_, whole: string, fraction: string) => {
      const cents = Math.round(Number(`${whole.replace(/,/g, "")}.${fraction}`) * 100) / 100;
      const [w, f = "00"] = cents.toFixed(2).split(".");
      return `$${THOUSANDS(w)}.${f}`;
    })
    // Any other decimal figure with more than 7 places: not part of a longer word or hex run.
    .replace(/(?<![\w.])(\d+)\.(\d{8,})(?![\w])/g, (_, whole: string, fraction: string) => {
      const rounded = Number(`${whole}.${fraction}`).toFixed(7).replace(/0+$/, "").replace(/\.$/, "");
      return rounded;
    });
}
