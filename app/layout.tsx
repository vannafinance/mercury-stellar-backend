import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import { Navbar } from "@/components/navbar";
import { navbarItems } from "@/lib/constants";
import { ThemeProvider } from "@/contexts/theme-context";
import { QueryProvider } from "@/contexts/query-provider";
import { LedgerSubscriberProvider } from "@/contexts/ledger-subscriber";
import { PriceProvider } from "@/contexts/price-context";
import { ScaleWrapper } from "@/components/ui/scale-wrapper";
import { AppToaster } from "@/components/ui/app-toaster";
import { MarginAccountHydrator } from "@/components/margin-account-hydrator";
import { CopilotWidget } from "@/components/copilot/copilot-widget";

// Self-hosted, preloaded by next/font (no render-blocking external request, so
// it helps LCP). `display: "swap"` paints text immediately with a fallback and
// swaps the web font in once loaded, avoiding invisible-text (FOIT) delay.
const plusJakartaSans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["200", "300", "400", "500", "600", "700", "800"],
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-plus-jakarta-sans",
});

// Canonical site URL — drives absolute OpenGraph/Twitter/canonical links.
// Override per-environment with NEXT_PUBLIC_SITE_URL; falls back to the prod app.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://app.vanna.finance";

/**
 * Root document metadata applied to every route.
 *
 * `title.template` turns per-page titles into "<Page> · Vanna" while the home
 * page uses `title.default`. OpenGraph/Twitter cards make shared links render
 * with a proper preview instead of the previous create-next-app boilerplate.
 */
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Vanna — Leveraged Yield & Margin on Stellar",
    template: "%s · Vanna",
  },
  description:
    "Vanna is a DeFi protocol on Stellar for leveraged yield, lending, and margin trading. Supply assets to earn, borrow against collateral, and deploy one-click leveraged strategies on Soroban.",
  applicationName: "Vanna Protocol",
  keywords: [
    "Vanna",
    "Stellar",
    "Soroban",
    "DeFi",
    "leveraged yield",
    "margin trading",
    "lending",
    "borrow",
    "yield farming",
    "XLM",
    "USDC",
  ],
  authors: [{ name: "Vanna" }],
  creator: "Vanna",
  alternates: { canonical: "/" },
  icons: { icon: "/favicon.ico" },
  openGraph: {
    type: "website",
    siteName: "Vanna Protocol",
    url: SITE_URL,
    title: "Vanna — Leveraged Yield & Margin on Stellar",
    description:
      "Earn yield, borrow against collateral, and deploy one-click leveraged strategies on Stellar/Soroban.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Vanna — Leveraged Yield & Margin on Stellar",
    description:
      "Earn yield, borrow against collateral, and deploy one-click leveraged strategies on Stellar/Soroban.",
  },
  robots: { index: true, follow: true },
};

/**
 * App shell wrapping every route. Mounts the global provider stack in
 * dependency order — theme → React Query → ledger-tick subscriber → price feed
 * — then the persistent navbar, page content (scaled), and the toast portal.
 * `MarginAccountHydrator` restores the connected account's cached state on load.
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${plusJakartaSans.variable} antialiased`}
        style={{ fontFamily: 'var(--font-plus-jakarta-sans)' }}
      >
        <ThemeProvider>
          <QueryProvider>
            <LedgerSubscriberProvider>
              <PriceProvider>
                <MarginAccountHydrator />
                <Navbar items={navbarItems}/>
                <ScaleWrapper>{children}</ScaleWrapper>
                <CopilotWidget />
                <AppToaster />
              </PriceProvider>
            </LedgerSubscriberProvider>
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
