import { redirect } from "next/navigation";

/**
 * Options trading is currently restricted — only Spot is supported on the
 * Stellar build. Any hit to /trade/options bounces the user to /trade/spot.
 */
export default function OptionsRedirect(): never {
  redirect("/trade/spot");
}
