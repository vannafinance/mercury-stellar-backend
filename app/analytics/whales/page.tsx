import { redirect } from "next/navigation";

/** Whale concentration and activity now live on Top accounts. */
export default function WhalesRedirectPage() {
  redirect("/analytics/top-accounts");
}
