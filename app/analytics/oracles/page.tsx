import { redirect } from "next/navigation";

/** Reflector oracle prices now live on Prices. */
export default function OraclesRedirectPage() {
  redirect("/analytics/prices");
}
