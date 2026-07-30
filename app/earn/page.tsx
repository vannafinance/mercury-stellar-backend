"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { CollapsibleChart } from "@/components/ui/collapsible-chart";
import { Table } from "@/components/earn/table";
import { Carousel } from "@/components/ui/carousel";
import { vaultsTableHeadings, positionsTableHeadings } from "@/lib/constants/earn";
import { useUserStore } from "@/store/user";
import { useEarnVaultStore } from "@/store/earn-vault-store";
import { setSelectedPool } from "@/store/selected-pool-store";
import { AssetType } from "@/lib/stellar-utils";
import { usePoolData, useUserPositions, useEarnTransactions } from "@/hooks/use-earn";
import { useTokenPrices } from "@/hooks/use-token-prices";

// AQUARIUS_USDC / SOROSWAP_USDC piggyback on USDC's oracle price (no separate
// Reflector entry exists — the alias resolves inside oracle-price.ts).
const PRICE_TOKEN_FOR_ASSET: Record<string, string> = {
  XLM: 'XLM',
  USDC: 'USDC',
  AQUARIUS_USDC: 'USDC',
  SOROSWAP_USDC: 'USDC',
};
const ALL_ASSETS = [
  "XLM", "USDC", "AQUARIUS_USDC", "SOROSWAP_USDC",
] as const;

// Chart data is derived entirely from Mercury's real per-account event
// history (see useEarnTransactions) plus current live state — never from
// browser storage. Clearing the browser's cache must not change what's
// shown here; Mercury (and on-chain state) is the only source of truth.
const toChartPoints = (
  points: Array<{ timestamp: number; amount: number }>
): Array<{ date: string; amount: number }> => {
  if (points.length === 0) return [];
  const decimals = 2;
  const mapped = points
    .map((item) => ({
      date: new Date(item.timestamp).toISOString(),
      amount: parseFloat((item.amount || 0).toFixed(decimals)),
    }))
    .filter((item) => Number.isFinite(item.amount));

  if (mapped.length >= 2) return mapped;

  // A single real data point can't draw a line — duplicate it 60s earlier
  // so the chart renders a flat line at the true current value instead of
  // an empty state.
  const only = mapped[0];
  const prevTs = Math.max(points[0].timestamp - 60_000, points[0].timestamp - 1);
  return [
    { date: new Date(prevTs).toISOString(), amount: only.amount },
    only,
  ];
};

// Format a raw token amount into a compact human-readable string (e.g. 1250000 → "1.3M")
const formatTokenAmount = (amount: number): string => {
  if (amount <= 0) return "0";
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(2)}K`;
  return amount.toFixed(2);
};

const fmtUsd = (n: number): string =>
  `$${(n < 0 ? 0 : n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Build a single pool table row from live on-chain pool stats
const buildPoolRow = (
  assetSymbol: string,
  pool: {
    totalSupply: string;
    totalBorrowed: string;
    utilizationRate: string;
    supplyAPY: string;
    borrowAPY: string;
    isLoading?: boolean;
  },
  price: number,
  // How much of THIS specific pool's asset the connected wallet has supplied
  // — 0 when they have no position here. Rendered the same two-line way as
  // "Assets Supplied" (amount on top, $ value below) so "Your Supply" reads
  // consistently instead of collapsing to a bare icon or dash.
  yourSupplyAmount: number
) => {
  const totalSupply = parseFloat(pool.totalSupply) || 0;
  const totalBorrowed = parseFloat(pool.totalBorrowed) || 0;
  const utilizationRate = parseFloat(pool.utilizationRate) || 0;
  const supplyAPY = parseFloat(pool.supplyAPY) || 0;
  const borrowAPY = parseFloat(pool.borrowAPY) || 0;

  return {
    cell: [
      { chain: assetSymbol, title: assetSymbol, tag: "Active" },
      {
        title: `${formatTokenAmount(totalSupply)} ${assetSymbol}`,
        tag: fmtUsd(totalSupply * price),
      },
      {
        title: `${supplyAPY.toFixed(2)}%`,
        tag: `${supplyAPY.toFixed(2)}%`,
      },
      {
        title: `${formatTokenAmount(totalBorrowed)} ${assetSymbol}`,
        tag: fmtUsd(totalBorrowed * price),
      },
      {
        title: `${borrowAPY.toFixed(2)}%`,
        tag: `${borrowAPY.toFixed(2)}%`,
      },
      {
        title: `${utilizationRate.toFixed(2)}%`,
        tag: `${utilizationRate.toFixed(2)}%`,
      },
      {
        title: `${formatTokenAmount(yourSupplyAmount)} ${assetSymbol}`,
        tag: fmtUsd(yourSupplyAmount * price),
      },
    ],
  };
};

// Build a positions row showing user's deposited amount for an asset. No
// "Assets Borrowed" column here — this table is already scoped to the user's
// own supplied positions, so a pool-wide borrow figure doesn't apply.
const buildPositionRow = (
  assetSymbol: string,
  position: {
    deposited: string;
    borrowed: string;
    vTokenBalance: string;
    earnedInterest: string;
    accruedDebt: string;
  },
  pool: {
    supplyAPY: string;
    borrowAPY: string;
    utilizationRate: string;
  },
  price: number
) => {
  const deposited = parseFloat(position.deposited) || 0;
  const supplyAPY = parseFloat(pool.supplyAPY) || 0;
  const borrowAPY = parseFloat(pool.borrowAPY) || 0;
  const utilizationRate = parseFloat(pool.utilizationRate) || 0;

  return {
    cell: [
      { chain: assetSymbol, title: assetSymbol, tag: "Active" },
      {
        title: `${formatTokenAmount(deposited)} ${assetSymbol}`,
        tag: fmtUsd(deposited * price),
      },
      {
        title: `${supplyAPY.toFixed(2)}%`,
        tag: `${supplyAPY.toFixed(2)}%`,
      },
      {
        title: `${borrowAPY.toFixed(2)}%`,
        tag: `${borrowAPY.toFixed(2)}%`,
      },
      {
        title: `${utilizationRate.toFixed(2)}%`,
        tag: `${utilizationRate.toFixed(2)}%`,
      },
    ],
  };
};

type VaultTableCell = {
  chain?: string;
  title?: string;
  tag?: string;
  onlyIcons?: string[];
};

export default function Earn() {
  const userAddress = useUserStore((state) => state.address);
  const setSelectedVault = useEarnVaultStore((state) => state.set);
  const router = useRouter();
  const [activeTab, setActiveTab] = useState("vaults");
  // const { getPrice } = useTokenPrices();

  // Live data from on-chain contracts (auto-refreshes every 30s)
  const { pools, isLoading: poolsLoading } = usePoolData();
  const { positions: userPositions, isLoading: positionsLoading } = useUserPositions();
  const { transactions: earnTx, isLoading: earnTxLoading } = useEarnTransactions();
  const tokenPrices = useTokenPrices(['XLM', 'USDC']);

  // Set default pool selection on mount
  useEffect(() => {
    setSelectedPool('XLM' as AssetType, {
      id: 'XLM',
      chain: 'XLM',
      title: 'XLM',
      tag: 'Active'
    });
  }, []);

  // Deep-link into the Positions tab (e.g. from Portfolio's Lender "Current
  // Positions" row) via /earn?tab=positions. Read directly off the URL
  // instead of next/navigation's useSearchParams so this doesn't force a
  // Suspense boundary on an otherwise fully client-rendered page.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const tab = new URLSearchParams(window.location.search).get("tab");
    if (tab === "positions") queueMicrotask(() => setActiveTab("positions"));
  }, []);

  const { totalDepositedUSD, earnedYieldUSD } = useMemo(() => {
    let totalUSD = 0;
    let earnedUSD = 0;

    // Net earnings = current vToken-derived value minus net principal
    // (Σ supply − Σ withdraw, both in real underlying units — Mercury's
    // withdraw amount is `asset_amount`, not the vToken share count, so this
    // is an exact reconstruction, not an exchange-rate approximation). Same
    // pattern as the Margin Positions table's "interest accrued" calc.
    // Skipped while the transaction history is still loading so we don't
    // show a misleadingly-inflated number (principal defaulting to 0).
    const netPrincipalByAsset: Record<string, number> = {};
    if (!earnTxLoading) {
      for (const tx of earnTx) {
        const amt = parseFloat(tx.amount) || 0;
        if (!(amt > 0)) continue;
        netPrincipalByAsset[tx.asset] = (netPrincipalByAsset[tx.asset] ?? 0) +
          (tx.type === "supply" ? amt : -amt);
      }
    }

    ALL_ASSETS.forEach((asset) => {
      const depositedTokens = parseFloat(userPositions[asset]?.deposited || "0");
      const price = tokenPrices[PRICE_TOKEN_FOR_ASSET[asset] ?? asset] ?? 1;
      totalUSD += depositedTokens * price;

      // Only count an asset's yield once we've actually SEEN at least one
      // supply/withdraw event for it. A missing history entry means "we
      // don't know this asset's principal" — NOT "principal is 0". Treating
      // it as 0 misreports the entire deposit as earned yield the moment a
      // pool has a live position but Mercury has no recorded activity for it
      // yet (e.g. a pool whose liquidity wasn't supplied through the normal
      // deposit() flow) — exactly the bug this guarded against.
      if (!earnTxLoading && Object.prototype.hasOwnProperty.call(netPrincipalByAsset, asset)) {
        const principal = Math.max(0, netPrincipalByAsset[asset]);
        const diff = depositedTokens - principal;
        if (diff > 0) earnedUSD += diff * price;
      }
    });

    return {
      totalDepositedUSD: totalUSD,
      earnedYieldUSD: earnedUSD,
    };
  }, [userPositions, tokenPrices, earnTx, earnTxLoading]);

  // Overall Deposit history: replay Mercury's real supply/withdraw events
  // chronologically to get genuine historical principal, priced at TODAY's
  // rates (same simplification the headline figure already uses, so the
  // chart's last point always matches it exactly). No client-side storage —
  // recomputed fresh from Mercury on every load.
  const liveDepositData = useMemo(() => {
    if (earnTxLoading || earnTx.length === 0) {
      return toChartPoints([{ timestamp: Date.now(), amount: totalDepositedUSD }]);
    }

    const sorted = [...earnTx].sort((a, b) => a.timestamp - b.timestamp);
    const running: Record<string, number> = {};
    const points = sorted.map((tx) => {
      const amt = parseFloat(tx.amount) || 0;
      running[tx.asset] = (running[tx.asset] ?? 0) + (tx.type === "supply" ? amt : -amt);
      let usd = 0;
      ALL_ASSETS.forEach((asset) => {
        const price = tokenPrices[PRICE_TOKEN_FOR_ASSET[asset] ?? asset] ?? 1;
        usd += Math.max(0, running[asset] ?? 0) * price;
      });
      return { timestamp: tx.timestamp, amount: usd };
    });

    // Final point: the live headline total (includes accrued yield beyond
    // raw principal), so the chart never disagrees with the stat above it.
    points.push({ timestamp: Date.now(), amount: totalDepositedUSD });
    return toChartPoints(points);
  }, [earnTx, earnTxLoading, tokenPrices, totalDepositedUSD]);

  // Net Earnings has no cheap, honest historical reconstruction (it needs
  // each pool's exchange rate at every past moment, which we don't record) —
  // rather than fabricate a curve, show the one real, correctly-computed
  // number as a flat line at its true current value.
  const liveEarnedYieldData = useMemo(
    () => toChartPoints([{ timestamp: Date.now(), amount: earnedYieldUSD }]),
    [earnedYieldUSD]
  );

  // Dust threshold: 0.0001 token. After a 100% withdrawal, contracts typically
  // leave 1-100 stroops (1e-7 to 1e-5) of rounding residue in the user's
  // vToken balance — purely numerical, not a real position. Filtering at
  // 1e-4 hides that dust everywhere consistently.
  const POSITION_DUST = 1e-4;

  // ─── Vaults Table ────────────────────────────────────────────────────────────
  // Each row reflects live pool-level stats fetched from the lending contracts.
  const liveVaultsTableBody = useMemo(() => {
    // Below dust, treat as no position — matches the Positions tab's own
    // cutoff so "Your Supply" doesn't show stroop-level rounding residue.
    const suppliedAmount = (asset: (typeof ALL_ASSETS)[number]) => {
      const amt = parseFloat(userPositions[asset]?.deposited || "0");
      return amt > POSITION_DUST ? amt : 0;
    };
    return {
      rows: [
        buildPoolRow("XLM", pools.XLM, tokenPrices["XLM"] ?? 0, suppliedAmount("XLM")),
        buildPoolRow("BLUSDC", pools.USDC, tokenPrices["USDC"] ?? 1, suppliedAmount("USDC")),
        buildPoolRow("AqUSDC", pools.AQUARIUS_USDC, tokenPrices["USDC"] ?? 1, suppliedAmount("AQUARIUS_USDC")),
        buildPoolRow("SoUSDC", pools.SOROSWAP_USDC, tokenPrices["USDC"] ?? 1, suppliedAmount("SOROSWAP_USDC")),
      ],
    };
  }, [pools, userPositions, tokenPrices]);

  // ─── Positions Table ─────────────────────────────────────────────────────────
  // Shows only the assets where the user has a meaningful (non-dust) balance.
  const livePositionsTableBody = useMemo(() => {
    if (!userAddress) return { rows: [] };

    const assetKeys = [
      "XLM", "USDC", "AQUARIUS_USDC", "SOROSWAP_USDC",
    ] as const;
    const rows = assetKeys
      .filter(
        (asset) => parseFloat(userPositions[asset]?.deposited || "0") > POSITION_DUST ||
                   parseFloat(userPositions[asset]?.borrowed || "0") > POSITION_DUST
      )
      .map((asset) => {
        const displaySymbol =
          asset === "AQUARIUS_USDC" ? "AqUSDC"
          : asset === "SOROSWAP_USDC" ? "SoUSDC"
          : asset === "USDC" ? "BLUSDC"
          : asset;
        const price = tokenPrices[PRICE_TOKEN_FOR_ASSET[asset] ?? asset] ?? (asset === "XLM" ? 0 : 1);
        return buildPositionRow(displaySymbol, userPositions[asset], pools[asset], price);
      });

    return { rows };
  }, [userAddress, userPositions, pools, tokenPrices]);

  // Tab-based table data
  const getTableDataForTab = (tabId: string) => {
    if (tabId === "vaults") return liveVaultsTableBody;
    if (tabId === "positions") return livePositionsTableBody;
    return { rows: [] };
  };

  // ─── Row Click Handler ────────────────────────────────────────────────────────
  // Looks up cells by column id (rather than a fixed numeric index) since the
  // Vaults and Positions tabs render different heading sets (e.g. Positions
  // has no "Assets Borrowed" column) — a fixed index would silently read the
  // wrong cell depending on which tab was active when the row was clicked.
  const handleRowClick = useCallback(
    (row: { cell?: VaultTableCell[] }) => {
      const cells = row.cell ?? [];
      const id = cells[0]?.title ?? "";
      const headings = activeTab === "positions" ? positionsTableHeadings : vaultsTableHeadings;
      const cellFor = (headingId: string): VaultTableCell | undefined => {
        const idx = headings.findIndex((h) => h.id === headingId);
        return idx === -1 ? undefined : cells[idx];
      };

      if (id) {
        const assetType =
          id === "AqUSDC" || id === "AquiresUSDC"
            ? "AQUARIUS_USDC"
            : id === "SoUSDC" || id === "SoroswapUSDC"
              ? "SOROSWAP_USDC"
              : id === "BLUSDC"
                ? "USDC"
                : id.toUpperCase();
        if (
          assetType === "XLM" || assetType === "USDC" ||
          assetType === "AQUARIUS_USDC" || assetType === "SOROSWAP_USDC"
        ) {
          setSelectedPool(assetType as AssetType, {
            id: id,
            chain: assetType,
            title: id,
            tag: cells[0]?.tag || "Active",
          });
        }

        const vaultData = {
          id: id,
          chain: cells[0]?.chain ?? "XLM",
          title: cells[0]?.title ?? "",
          tag: cells[0]?.tag ?? "Active",
          assetsSupplied: { title: cellFor("assets-supplied")?.title || "", tag: cellFor("assets-supplied")?.tag || "" },
          supplyApy: { title: cellFor("supply-apy")?.title || "", tag: cellFor("supply-apy")?.tag || "" },
          assetsBorrowed: { title: cellFor("assets-borrowed")?.title || "", tag: cellFor("assets-borrowed")?.tag || "" },
          borrowApy: { title: cellFor("borrow-apy")?.title || "", tag: cellFor("borrow-apy")?.tag || "" },
          utilizationRate: { title: cellFor("utilization-rate")?.title || "", tag: cellFor("utilization-rate")?.tag || "" },
        };

        setSelectedVault({ selectedVault: vaultData });
        router.push(`/earn/${id}`);
      }
    },
    [router, setSelectedVault, activeTab]
  );

  const earnCarouselItems = [
    {
      icon: "",
      title: "Earn Yield on Your Assets",
      description:
        "Supply liquidity to Vanna vaults and earn competitive APY. Your funds work 24/7 — no lockups, withdraw anytime.",
    },
    {
      icon: "",
      title: "Multi-Collateral Vaults",
      description:
        "Deposit multiple assets as collateral and borrow against them. Diversify risk while maximizing capital efficiency.",
    },
    {
      icon: "",
      title: "Audited & Battle-Tested",
      description:
        "Vanna Protocol's smart contracts are fully audited. Secure, transparent, and built for DeFi power users.",
    },
  ];

  return (
    <main className="w-full px-4 sm:px-10 lg:px-30 pb-8 lg:pb-0">
      {/* Promotional Carousel */}
      <section className="w-full pt-4 sm:pt-6 pb-4">
        <Carousel items={earnCarouselItems} autoplayInterval={5000} />
      </section>

      {/* Stats with expandable charts — below carousel, side by side */}
      {userAddress && (
        <section className="w-full pb-4 flex flex-col lg:flex-row gap-3" aria-label="Protocol Dashboard">
          <article className="flex-1 min-w-0">
            <CollapsibleChart
              label="Overall Deposit"
              // Headline reads the LIVE total (same source as the Positions
              // table) so it updates instantly on deposit/withdraw. The chart
              // curve still uses the throttled snapshots so the long-range shape
              // stays smooth — only the number is decoupled from the throttle.
              statValue={`$${totalDepositedUSD.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              chartProps={{
                type: "overall-deposit",
                customData: liveDepositData,
              }}
            />
          </article>
          <article className="flex-1 min-w-0">
            <CollapsibleChart
              label="Net Earnings"
              // Renders the same way "Overall Deposit" does at $0.00 — a flat
              // chart, not a special empty-state card — so a brand-new
              // account looks consistent across both cards.
              statValue={(() => {
                const v = liveEarnedYieldData.length > 0
                  ? liveEarnedYieldData[liveEarnedYieldData.length - 1].amount
                  : 0;
                return `$${v.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}`;
              })()}
              chartProps={{
                type: "net-apy",
                customData: liveEarnedYieldData,
              }}
            />
          </article>
        </section>
      )}

      {/* Pool Table — full width */}
      <section className="w-full pb-8" aria-label="Vaults and Positions">
        <Table
          filterDropdownPosition="right"
          filters={{
            filters: ["Deposit"],
            allChainDropdown: true,
            supplyApyTab: true,
          }}
          heading={{
            tabsItems: [
              { id: "vaults", label: "Vaults" },
              { id: "positions", label: "Positions" },
            ],
            tabType: "underline",
          }}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          tableHeadings={activeTab === "positions" ? positionsTableHeadings : vaultsTableHeadings}
          tableBody={getTableDataForTab(activeTab)}
          onRowClick={handleRowClick}
          hoverBackground="hover:bg-[#F1EBFD]"
        />
      </section>
    </main>
  );
}
