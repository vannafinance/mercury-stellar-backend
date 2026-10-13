import { AccountPage } from "@/components/analytics/v3/views/account";

/** Legacy per-wallet URL: now the real account page (wallet G… or margin account C…), reached from Positions. */
export default async function Page({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  return <AccountPage address={decodeURIComponent(address)} from="positions" />;
}
