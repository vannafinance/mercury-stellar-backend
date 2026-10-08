import { allAssets, assetsNamedIn, isSupportedAsset, mentionsBareUsdc } from "../registry/assets";

/**
 * A request whose every named asset is one Vanna does not support is refused at once, before any
 * model turn or read (8 Oct: "lend 5 AQUA" and "provide EURC liquidity" took 26 to 42 s to arrive at
 * a refusal the registry could give in a moment).
 *
 * Which assets those are comes from the registry's own venue data (`isSupportedAsset`), and which
 * assets a message names comes from the registry's own aliases. Nothing here reads the wording of a
 * request: a message that also names a supported asset, or says a bare "USDC", is not refused here
 * and goes through the normal investigation, which has to ask or answer for the part it can.
 */
export function unsupportedOnlyReply(message: string): string | null {
  const named = assetsNamedIn(message);
  if (!named.length || named.some(isSupportedAsset) || mentionsBareUsdc(message)) return null;
  const labels = named.map((def) => def.displayLabel);
  const supported = allAssets().filter(isSupportedAsset).map((def) => def.displayLabel);
  const list = (items: string[]) => items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}` : items[0];
  return `${list(labels)} ${labels.length > 1 ? "are" : "is"} not supported on Vanna, so I can't help with ${labels.length > 1 ? "those" : "that"}. I can work with ${list(supported)}.`;
}
