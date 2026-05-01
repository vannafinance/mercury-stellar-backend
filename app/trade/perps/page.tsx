import { redirect } from "next/navigation";

/**
 * Perps trading is currently restricted — only Spot is supported on the
 * Stellar build. Any hit to /trade/perps bounces the user to /trade/spot.
 */
export default function PerpsRedirect(): never {
  redirect("/trade/spot");
}
