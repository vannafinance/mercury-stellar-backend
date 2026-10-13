import { redirect } from "next/navigation";

/** Stress testing lives on the What-if Calculator (with Risk Explorer for preset stress tests). */
export default function StressTestRedirectPage() {
  redirect("/analytics/what-if");
}
