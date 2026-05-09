import { redirect } from "next/navigation";

/** Stress testing UI lives on Risk Explorer (preset stress tests). */
export default function StressTestRedirectPage() {
  redirect("/risk-explorer");
}
