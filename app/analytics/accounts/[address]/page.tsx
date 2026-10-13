import { AccountPage } from "@/components/analytics/v3/views/account";
import { parseFrom } from "@/lib/analytics/v3/links";

/** /analytics/accounts/<margin account or wallet address>?from=overview|top|liquidations|alerts|positions|whatif */
export default async function Page({ params, searchParams }: { params: Promise<{ address: string }>; searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const { address } = await params;
  const { from } = await searchParams;
  return <AccountPage address={decodeURIComponent(address)} from={parseFrom(from)} />;
}
