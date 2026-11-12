"use client";

/**
 * Add / Remove column of a V3 Farm pool page (the design's `kamAside`), wired exactly like the
 * previous Farm form (components/farm/add-liquidity.tsx + remove-liquidity.tsx), all from the
 * user's MARGIN ACCOUNT:
 *
 * - Blend (single asset): Supply moves the margin account's XLM / USDC into the Blend pool
 *   (`BlendService.depositToBlendPool`), with the projected-earnings summary and the
 *   borrow-vs-collateral source attribution; Withdraw is entered in b-tokens (what Blend burns),
 *   converted to underlying at the live b-rate, and a full withdrawal re-reads the accrued balance
 *   right before submitting.
 * - Aquarius / Soroswap (LP): Add Liquidity takes both tokens, auto-pairing the other amount from
 *   the pool's live reserves (`AquariusService.addLiquidity` / `SoroswapService.addLiquidity`, same
 *   argument order as before); Remove Liquidity burns LP shares, and 100% pins the exact LP balance.
 *
 * Every protocol rule (Aquarius pool-type check and router argument order, Soroswap budget
 * handling, trustlines, health checks) lives in those services and the contracts — unchanged.
 * Tx progress uses showTxStep / showTxSuccess / showTxError as before.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BeforeAfter, Icon, IC } from "@/components/v3/icons";
import { Info } from "@/components/v3/ui";
import { nf, pct, tokFmt, usd } from "@/components/v3/format";
import { useUserStore } from "@/store/user";
import { useFarmStore } from "@/store/farm-store";
import { useMarginAccountInfoStore, refreshBorrowedBalances } from "@/store/margin-account-info-store";
import { BlendService } from "@/lib/blend-utils";
import { AquariusService, type AquariusSwapSymbol } from "@/lib/aquarius-utils";
import { SoroswapService, type SoroswapSwapSymbol } from "@/lib/soroswap-utils";
import { MarginAccountService } from "@/lib/margin-utils";
import { DEPOSIT_PERCENTAGES } from "@/lib/constants/margin";
import { useBlendPoolStats, useAquariusPoolStats } from "@/hooks/use-farm";
import { useSoroswapPoolStats } from "@/hooks/use-soroswap";
import { useTokenPrice } from "@/hooks/use-token-prices";
import { normalizeContractError } from "@/lib/errors/normalize";
import { showTxStep, showTxSuccess, showTxError } from "@/lib/tx-progress";
import { validateAmountChange } from "@/lib/utils/sanitize-amount";
import { attributeFarmDeposit } from "@/lib/utils/margin-token-attribution";
import { TabsBox, useOutside } from "./fm-ui";
import { BLEND_TOKENS, venueLabel, type BlendToken, type FarmPoolRef } from "./farm-pools";

const PERCENTAGE_OPTIONS = [25, 50, 75, 100] as const;
const NETWORK_LABEL = "Stellar Testnet";

type TxStatus = "idle" | "loading" | "success" | "error";

/**
 * The connected wallet and its margin account. The address comes from the runtime margin-account
 * cache (`MarginAccountService.getStoredMarginAccount`, as the old form read it), falling back to
 * the margin store's address when the cache hadn't been filled yet.
 */
function useMarginAddress() {
  const userAddress = useUserStore((s) => s.address);
  const storeAddress = useMarginAccountInfoStore((s) => s.marginAccountAddress);
  const cached = userAddress ? (MarginAccountService.getStoredMarginAccount(userAddress)?.address ?? null) : null;
  return { userAddress, marginAccountAddress: userAddress ? (cached ?? storeAddress ?? null) : null };
}

// Balance reads below are React Queries under the `['farm', …]` prefix, so the `['farm']`
// invalidation after every farm transaction re-reads them (failed reads fall back to "0", as before).

/** Whether the Blend pool is configured in the Registry (a failed read counts as not configured). */
function useBlendConfigured(): boolean | null {
  const q = useQuery({
    queryKey: ["farm", "v3", "blendConfigured"],
    queryFn: () => BlendService.isBlendPoolConfigured().catch(() => false),
    staleTime: 5 * 60_000,
  });
  return q.data ?? null;
}

/** The margin account's Blend supply of `token`: underlying + b-token balance strings. */
function useBlendBalance(marginAccountAddress: string | null, token: BlendToken) {
  const q = useQuery({
    queryKey: ["farm", "v3", "blendBalance", marginAccountAddress, token],
    enabled: Boolean(marginAccountAddress),
    queryFn: () =>
      BlendService.getUserBlendBalance(marginAccountAddress!, token)
        .then((info) => ({ underlyingBalance: info.underlyingBalance, bTokenBalance: info.bTokenBalance }))
        .catch(() => ({ underlyingBalance: "0", bTokenBalance: "0" })),
    staleTime: 4_000,
  });
  return {
    underlyingBalance: marginAccountAddress ? (q.data?.underlyingBalance ?? "0") : "0",
    bTokenBalance: marginAccountAddress ? (q.data?.bTokenBalance ?? "0") : "0",
    loading: Boolean(marginAccountAddress) && q.isLoading,
    refetch: q.refetch,
  };
}

export function PoolAction({ pool }: { pool: FarmPoolRef }) {
  const [act, setAct] = useState<"add" | "remove">("add");
  const blend = pool.kind === "blend";
  return (
    <section className="fm-act k">
      <TabsBox
        items={[
          ["add", blend ? "Supply" : "Add Liquidity"],
          ["remove", blend ? "Withdraw" : "Remove Liquidity"],
        ]}
        value={act}
        onChange={setAct}
      />
      {/* Keyed by pool so the form resets when switching pools. */}
      {pool.kind === "blend" ? (
        act === "add" ? (
          <BlendSupplyPanel key={pool.id} token={pool.token} />
        ) : (
          <BlendWithdrawPanel key={pool.id} token={pool.token} />
        )
      ) : act === "add" ? (
        <LpAddPanel key={pool.id} pool={pool} />
      ) : (
        <LpRemovePanel key={pool.id} pool={pool} />
      )}
    </section>
  );
}

/**
 * Blend token switcher (the old form's token dropdown). Mirrors the Earn page's asset dropdown:
 * it navigates so the WHOLE page — header stats, tables, all keyed off the [id] route — reflects the
 * newly picked pool. `tabType: "single"` keeps the Farm list on its Lending tab on the way back.
 */
function BlendTokenMenu({ token, receipt }: { token: BlendToken; receipt?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  const router = useRouter();
  const setFarmData = useFarmStore((s) => s.set);
  const label = (t: BlendToken) => (receipt ? `b${t}` : venueLabel("Blend", t));
  return (
    <span className="fm-tokw" ref={ref}>
      <button type="button" className="fm-tokb" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon sym={token} className="fm-ico20" />
        {label(token)} {IC.chev}
      </button>
      {open && (
        <div className="pop r fm-tokm" role="listbox">
          <p>Blend pool</p>
          {BLEND_TOKENS.map((t) => (
            <button
              key={t}
              type="button"
              role="option"
              aria-selected={t === token}
              className={t === token ? "on" : ""}
              onClick={() => {
                setOpen(false);
                if (t === token) return;
                setFarmData({ tabType: "single" });
                router.push(`/farm/${t.toLowerCase()}`);
              }}
            >
              <Icon sym={t} className="fm-ico16" />
              {label(t)}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Blend — Supply
// ─────────────────────────────────────────────────────────────────────────────

function BlendSupplyPanel({ token: selectedToken }: { token: BlendToken }) {
  const { userAddress, marginAccountAddress } = useMarginAddress();
  const qc = useQueryClient();
  const [value, setValue] = useState("");
  const [pctOn, setPctOn] = useState(0);
  // Borrowed balances from margin account (amounts available to route into Blend)
  const borrowedBalances = useMarginAccountInfoStore((s) => s.borrowedBalances);
  const { stats: poolStats } = useBlendPoolStats();
  const [txStatus, setTxStatus] = useState<TxStatus>("idle");
  const [txError, setTxError] = useState("");
  // Check protocol configuration
  const blendConfigured = useBlendConfigured();
  // Current Blend supply balance for the selected token
  const { underlyingBalance: blendBalance } = useBlendBalance(marginAccountAddress, selectedToken);
  // The selected token's free balance in the margin account (what can be supplied).
  const marginTokenQuery = useQuery({
    queryKey: ["farm", "v3", "marginTokenBalance", marginAccountAddress, selectedToken],
    enabled: Boolean(marginAccountAddress),
    queryFn: () => BlendService.getMarginAccountTokenBalance(marginAccountAddress!, selectedToken).catch(() => "0"),
    staleTime: 4_000,
  });
  const marginTokenBalance = marginAccountAddress ? (marginTokenQuery.data ?? "0") : "0";
  const loadingMarginTokenBalance = Boolean(marginAccountAddress) && marginTokenQuery.isLoading;
  // Live oracle price for the selected deposit token; powers the projected-earnings summary.
  const tokenPriceUsd = useTokenPrice(selectedToken);

  // Refresh borrowed balances when margin account or token changes
  useEffect(() => {
    if (!marginAccountAddress) return;
    refreshBorrowedBalances(marginAccountAddress);
  }, [marginAccountAddress, selectedToken]);

  const depositToBlendMutation = useMutation({
    mutationFn: async ({ amount }: { amount: number }) => {
      const result = await BlendService.depositToBlendPool(userAddress!, marginAccountAddress!, selectedToken, amount);
      if (!result.success) {
        throw new Error(result.error ?? "Deposit failed");
      }
      return { ...result, amount };
    },
    onMutate: ({ amount }) => {
      setTxStatus("loading");
      setTxError("");
      showTxStep(`Depositing ${amount.toFixed(2)} ${selectedToken === "USDC" ? "BLUSDC" : selectedToken} to Blend`);
    },
    onSuccess: () => {
      setTxStatus("success");
      showTxSuccess("Deposit successful!");
      setValue("");
      setPctOn(0);
      // Re-reads pool stats, positions, history and this panel's Blend / margin balances.
      qc.invalidateQueries({ queryKey: ["farm"] });
      refreshBorrowedBalances(marginAccountAddress!, true);
    },
    onError: (error) => {
      setTxStatus("error");
      const errorMsg = normalizeContractError(error instanceof Error ? error.message : undefined, "Deposit failed");
      setTxError(errorMsg);
      showTxError(errorMsg);
    },
  });

  const handleDeposit = () => {
    if (!userAddress || !marginAccountAddress) return;
    const amount = parseFloat(value);
    if (isNaN(amount) || amount <= 0) return;
    depositToBlendMutation.mutate({ amount });
  };

  const isInputValid = parseFloat(value) > 0 && !isNaN(parseFloat(value));
  const blendDeployed = parseFloat(blendBalance);
  const marginRawNum = parseFloat(marginTokenBalance || "0");
  const borrowedForToken = parseFloat(borrowedBalances[selectedToken]?.amount ?? "0");
  const availableToDeployNum = marginRawNum;
  const availableToDeployStr = availableToDeployNum.toFixed(2);
  const depositAmountNum = parseFloat(value) || 0;
  const depositAttribution = attributeFarmDeposit(marginRawNum, blendDeployed, borrowedForToken, depositAmountNum);
  const isOverBalance = parseFloat(value) > availableToDeployNum;
  const isSubmitDisabled = !userAddress || !marginAccountAddress || blendConfigured === false || !isInputValid || isOverBalance || txStatus === "loading";

  // Pool's supply APY from on-chain Blend reserve config × utilization (null while loading).
  const reserveStats = poolStats[selectedToken];
  const supplyApyPct = reserveStats ? parseFloat(reserveStats.supplyAPY) : null;
  // Display-only — selectedToken itself stays the raw "XLM"/"USDC" used by every BlendService call.
  const tokenLabel = venueLabel("Blend", selectedToken);
  const depositUsd = depositAmountNum * (tokenPriceUsd || 0);
  const yearly = depositUsd * ((supplyApyPct ?? 0) / 100);
  const held = Number.isFinite(blendDeployed) ? blendDeployed : 0;

  const getButtonText = () => {
    if (!userAddress) return "Connect Wallet";
    if (!marginAccountAddress) return "Margin Account Required";
    if (blendConfigured === false) return "Blend Pool Not Configured";
    if (txStatus === "loading") return "Processing...";
    if (parseFloat(value) <= 0 || !value) return "Enter Amount";
    if (parseFloat(value) > availableToDeployNum) return `Insufficient ${selectedToken} Balance`;
    return `Supply ${tokenLabel} to Blend`;
  };

  return (
    <>
      <div className="fm-amt">
        <div className="fm-amt-t">
          <input
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={value}
            disabled={txStatus === "loading"}
            aria-label="Amount to supply"
            onChange={(e) => {
              const sanitized = validateAmountChange(e.target.value);
              if (sanitized === null) return;
              setValue(sanitized);
              setPctOn(0);
            }}
          />
          <BlendTokenMenu token={selectedToken} />
        </div>
        {/* USD equivalent of the entered amount (matches the earn supply/withdraw UX) */}
        <div className="fm-amt-u num">~ {usd(depositUsd)}</div>
        <div className="fm-amt-f">
          <span className="fm-pcs">
            {DEPOSIT_PERCENTAGES.map((p) => (
              <button
                key={p}
                type="button"
                disabled={txStatus === "loading"}
                className={pctOn === p ? "on" : ""}
                onClick={() => {
                  setPctOn(p);
                  setValue(((availableToDeployNum * p) / 100).toFixed(2));
                }}
              >
                {p}%
              </button>
            ))}
          </span>
          <button
            type="button"
            className="fm-maxl num"
            disabled={txStatus === "loading"}
            onClick={() => {
              setPctOn(0);
              setValue(availableToDeployStr);
            }}
          >
            Margin: {loadingMarginTokenBalance ? "..." : nf(availableToDeployNum, 2)} {selectedToken}
          </button>
        </div>
      </div>

      {/* Margin account warning */}
      {userAddress && !marginAccountAddress && <div className="fm-note">A margin account is required to supply to Blend. Please create one in the Margin section.</div>}
      {userAddress && marginAccountAddress && !loadingMarginTokenBalance && availableToDeployNum <= 0 && (
        <div className="fm-note">
          No {selectedToken} in your margin account. Deposit or borrow {selectedToken} on the Margin page first.
        </div>
      )}

      {depositAmountNum > 0 && (
        <div className="fm-pv num">
          <div className="kv">
            <span>Network</span>
            <span>
              <i className="fm-sq" />
              {NETWORK_LABEL}
            </span>
          </div>
          {(depositAttribution.fromBorrow > 0 || depositAttribution.fromOwn > 0) && (
            <div className="kv">
              <span>
                Source <Info text="Borrowed balance in the margin account is deployed first, then your own collateral." />
              </span>
              <span>
                {[
                  depositAttribution.fromBorrow > 0 ? `${nf(depositAttribution.fromBorrow, 4)} borrow` : "",
                  depositAttribution.fromOwn > 0 ? `${nf(depositAttribution.fromOwn, 4)} collateral` : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
          )}
          <div className="kv">
            <span>
              <Icon sym={selectedToken} className="fm-ico14" />
              Deposit ({tokenLabel})
            </span>
            <span>
              <BeforeAfter a={tokFmt(held, tokenLabel, false)} b={tokFmt(held + depositAmountNum, tokenLabel, false)} />
            </span>
          </div>
          <div className="kv">
            <span>APY</span>
            <span>{pct(supplyApyPct ?? 0)}</span>
          </div>
          <div className="kv">
            <span>Projected monthly earnings</span>
            <span className="pos">{usd(yearly / 12)}</span>
          </div>
          <div className="kv">
            <span>Projected yearly earnings</span>
            <span className="pos">{usd(yearly)}</span>
          </div>
        </div>
      )}
      {txError && <p className="fm-warnn dg">{txError}</p>}
      <button type="button" className="fm-cta" disabled={isSubmitDisabled} onClick={handleDeposit}>
        {getButtonText()}
      </button>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Blend — Withdraw
// ─────────────────────────────────────────────────────────────────────────────

function BlendWithdrawPanel({ token: selectedToken }: { token: BlendToken }) {
  const { userAddress, marginAccountAddress } = useMarginAddress();
  const qc = useQueryClient();
  const [value, setValue] = useState("");
  const [selectedPercentage, setSelectedPercentage] = useState(0);
  const [txStatus, setTxStatus] = useState<TxStatus>("idle");
  const [txError, setTxError] = useState("");
  // Check if Blend pool is configured in Registry
  const blendConfigured = useBlendConfigured();
  // Blend balance for the margin account and token (re-read after every farm transaction)
  const { underlyingBalance: blendBalance, bTokenBalance: blendBTokenBalance, loading: loadingBalance } = useBlendBalance(marginAccountAddress, selectedToken);

  // b-Rate (underlying per bToken) derived from the same balance read used for the "Available"
  // cap — matches the Position table's own b-Rate column so the preview stays consistent.
  const blendBRate = (() => {
    const bTok = parseFloat(blendBTokenBalance);
    const underlying = parseFloat(blendBalance);
    return bTok > 0 ? underlying / bTok : 1;
  })();

  const handlePercentageSelect = (p: number) => {
    setSelectedPercentage(p);
    // Blend rows enter the amount in b-Token terms (matches the Position table's "b-Tokens"
    // column and what actually gets burned), so the pills operate on blendBTokenBalance.
    const sourceBalanceStr = blendBTokenBalance;
    const balance = parseFloat(sourceBalanceStr);
    if (!isNaN(balance) && balance > 0) {
      // For 100% pin to the exact balance string so any trailing-precision drift (e.g. 8.85 vs
      // 8.8499999) doesn't push the input over the cap.
      const next = p === 100 ? sourceBalanceStr : ((balance * p) / 100).toFixed(7);
      setValue(next);
    }
  };

  const withdrawFromBlendMutation = useMutation({
    mutationFn: async ({ amount }: { amount: number }) => {
      const result = await BlendService.withdrawFromBlendPool(userAddress!, marginAccountAddress!, selectedToken, amount);
      if (!result.success) {
        throw new Error(result.error ?? "Withdrawal failed");
      }
      return { ...result, amount };
    },
    onMutate: ({ amount }) => {
      setTxStatus("loading");
      setTxError("");
      showTxStep(`Withdrawing ${amount.toFixed(2)} ${selectedToken} from Blend`);
    },
    onSuccess: () => {
      setTxStatus("success");
      showTxSuccess("Withdrawal successful!");
      setValue("");
      setSelectedPercentage(0);
      // Re-reads pool stats, positions, history and this panel's Blend balance.
      qc.invalidateQueries({ queryKey: ["farm"] });
    },
    onError: (error) => {
      setTxStatus("error");
      const errorMsg = normalizeContractError(error instanceof Error ? error.message : undefined, "Withdrawal failed");
      setTxError(errorMsg);
      showTxError(errorMsg);
    },
  });

  const handleWithdraw = async () => {
    if (!userAddress || !marginAccountAddress) return;
    // `value` is entered in b-Token terms — the on-chain Withdraw call still takes an UNDERLYING
    // amount (Blend burns whatever b-tokens that underlying amount corresponds to), so convert via
    // the current b-Rate before submitting.
    const bTokenAmount = parseFloat(value);
    if (isNaN(bTokenAmount) || bTokenAmount <= 0) return;
    let amount = bTokenAmount * blendBRate;

    const displayedAvailable = parseFloat(blendBTokenBalance) || 0;
    const isFullWithdrawalIntent = selectedPercentage === 100 || Math.abs(bTokenAmount - displayedAvailable) < 0.0000001;

    // For 100% remove, fetch the latest balance right before tx so the call targets the full
    // accrued underlying amount (including interest updates since the last balance fetch).
    if (isFullWithdrawalIntent) {
      try {
        const latest = await BlendService.getUserBlendBalance(marginAccountAddress, selectedToken);
        const latestBTokens = parseFloat(latest.bTokenBalance);
        const latestUnderlying = parseFloat(latest.underlyingBalance);
        if (!isNaN(latestUnderlying) && latestUnderlying > 0) {
          amount = latestUnderlying;
          if (!isNaN(latestBTokens)) setValue(latestBTokens.toFixed(7));
        }
      } catch (err) {
        console.warn("[RemoveLiquidity] Failed to refresh latest Blend balance before full withdraw:", err);
      }
    }

    withdrawFromBlendMutation.mutate({ amount });
  };

  const isInputValid = parseFloat(value) > 0 && !isNaN(parseFloat(value));
  // `value` is entered in b-Token terms — compare against the b-Token balance.
  const isOverBalance = parseFloat(value) > parseFloat(blendBTokenBalance);
  const isSubmitDisabled = !userAddress || !marginAccountAddress || blendConfigured === false || !isInputValid || isOverBalance || txStatus === "loading";

  const bTokenLabel = `b${selectedToken}`;
  const totalLiquidity = parseFloat(blendBTokenBalance) || 0;
  const enteredBTokenAmount = parseFloat(value);
  const enteredUnderlyingAmount = !isNaN(enteredBTokenAmount) && enteredBTokenAmount > 0 ? enteredBTokenAmount * blendBRate : 0;
  const underlying = parseFloat(blendBalance) || 0;

  const buttonText = () => {
    if (!userAddress) return "Connect Wallet";
    if (!marginAccountAddress) return "Margin Account Required";
    if (blendConfigured === false) return "Blend Pool Not Configured";
    if (txStatus === "loading") return "Withdrawing...";
    if (!isInputValid) return "Enter Amount";
    if (isOverBalance) return "Insufficient Balance";
    return `Withdraw ${selectedToken} to Margin Account`;
  };

  return (
    <>
      <div className="fm-wpos">
        <span>Your Blend Position</span>
        <b className="num">
          <Icon sym={selectedToken} className="fm-ico16" />
          {loadingBalance ? "..." : `${tokFmt(underlying, venueLabel("Blend", selectedToken))} · ${nf(totalLiquidity, 4)} ${bTokenLabel}`}
        </b>
      </div>
      <div className="fm-amt">
        <div className="fm-amt-t">
          <input
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={value}
            disabled={txStatus === "loading"}
            aria-label={`Amount of ${bTokenLabel} to withdraw`}
            onChange={(e) => {
              const sanitized = validateAmountChange(e.target.value);
              if (sanitized === null) return;
              setValue(sanitized);
              setSelectedPercentage(0);
            }}
          />
          <BlendTokenMenu token={selectedToken} receipt />
        </div>
        <div className="fm-amt-u num">{isOverBalance ? <span className="neg">Exceeds your {bTokenLabel} balance</span> : `~ ${tokFmt(enteredUnderlyingAmount, selectedToken)}`}</div>
        <div className="fm-amt-f">
          <span className="fm-pcs">
            {PERCENTAGE_OPTIONS.map((p) => (
              <button key={p} type="button" disabled={txStatus === "loading"} className={selectedPercentage === p ? "on" : ""} onClick={() => handlePercentageSelect(p)}>
                {p}%
              </button>
            ))}
          </span>
          <span className="fm-maxl num" style={{ textDecoration: "none" }}>
            Available: {loadingBalance ? "..." : totalLiquidity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 7 })} {bTokenLabel}
          </span>
        </div>
      </div>

      {/* Underlying-amount preview — the input is entered in b-Token terms, so show what that
          actually redeems for in the real underlying asset before submitting. */}
      {enteredUnderlyingAmount > 0 && (
        <div className="fm-pv num">
          <div className="kv">
            <span>You will get</span>
            <span>
              {enteredUnderlyingAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 7 })} {selectedToken} to margin account
            </span>
          </div>
          <div className="kv">
            <span>b-Rate</span>
            <span>
              1 {bTokenLabel} = {nf(blendBRate, 4)} {selectedToken}
            </span>
          </div>
        </div>
      )}

      {/* Margin account warning */}
      {userAddress && !marginAccountAddress && <div className="fm-note">A margin account is required to withdraw from Blend. Please create one in the Margin section.</div>}
      {txError && <p className="fm-warnn dg">{txError}</p>}
      <button type="button" className="fm-cta" disabled={isSubmitDisabled} onClick={handleWithdraw}>
        {buttonText()}
      </button>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Aquarius / Soroswap — Add Liquidity
// ─────────────────────────────────────────────────────────────────────────────

type LpPool = FarmPoolRef & { kind: "aquarius" | "soroswap" };

/** Live pool reserves for the LP panels, ordered as the pool config's `tokens`. */
function useLpReserves(pool: LpPool) {
  const isSoroswapPool = pool.kind === "soroswap";
  const { stats: aqStats } = useAquariusPoolStats(pool.kind === "aquarius" ? pool.cfg.poolAddress : null);
  const { stats: ssStats } = useSoroswapPoolStats(isSoroswapPool, isSoroswapPool ? pool.cfg.pairAddress : undefined);
  const reserveA = isSoroswapPool ? parseFloat(ssStats?.reserveXLM ?? "0") : parseFloat(aqStats?.reserveA ?? "0");
  const reserveB = isSoroswapPool ? parseFloat(ssStats?.reserveUSDC ?? "0") : parseFloat(aqStats?.reserveB ?? "0");
  const totalShares = parseFloat(isSoroswapPool ? (ssStats?.totalShares ?? "0") : (aqStats?.totalShares ?? "0"));
  return { reserveA, reserveB, totalShares };
}

/** Margin-account balance of one pool token, through the pool's own venue service. */
const dexTokenBalance = (pool: LpPool, marginAccountAddress: string, sym: string) =>
  pool.kind === "soroswap"
    ? SoroswapService.getMarginAccountTokenBalance(marginAccountAddress, sym as SoroswapSwapSymbol)
    : AquariusService.getMarginAccountTokenBalance(marginAccountAddress, sym as AquariusSwapSymbol);

function LpAddPanel({ pool }: { pool: LpPool }) {
  const { userAddress, marginAccountAddress } = useMarginAddress();
  const qc = useQueryClient();
  const isSoroswapPool = pool.kind === "soroswap";
  const isAquariusPool = pool.kind === "aquarius";
  const dexName = pool.venue;
  // Every balance fetch, reserve lookup and the actual addLiquidity() call MUST keep using the raw
  // tokens; the labels (AqUSDC / SoUSDC) are display only.
  const [tokenA, tokenB] = pool.tokens;
  const [tokenALabel, tokenBLabel] = pool.labels;
  const { reserveA, reserveB, totalShares } = useLpReserves(pool);

  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState("");
  // Which quick-fill percentage (if any) is active per token. Cleared on manual typing in either
  // input since the paired auto-calc means an edit to one token can make the other's stale.
  const [selectedPctA, setSelectedPctA] = useState(0);
  const [selectedPctB, setSelectedPctB] = useState(0);
  const [txStatus, setTxStatus] = useState<TxStatus>("idle");
  const [txError, setTxError] = useState("");
  const [aquariusRegistryMissing, setAquariusRegistryMissing] = useState(false);
  // Keyed by symbol (generic over whichever two tokens the pool actually is).
  const [marginDexBalances, setMarginDexBalances] = useState<Record<string, string>>({});
  const [loadingMarginBalances, setLoadingMarginBalances] = useState(false);

  const refreshDexMarginBalances = useCallback(
    async (retryCount = 1, retryDelayMs = 1200) => {
      if (!marginAccountAddress) return;
      setLoadingMarginBalances(true);
      try {
        for (let attempt = 0; attempt < retryCount; attempt++) {
          const [balA, balB] = await Promise.all([dexTokenBalance(pool, marginAccountAddress, tokenA), dexTokenBalance(pool, marginAccountAddress, tokenB)]);
          setMarginDexBalances({ [tokenA]: balA, [tokenB]: balB });
          if (attempt < retryCount - 1) {
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          }
        }
      } finally {
        setLoadingMarginBalances(false);
      }
    },
    [pool, marginAccountAddress, tokenA, tokenB],
  );

  // Aquarius is always usable via hardcoded fallback — check the Registry separately, for info only.
  useEffect(() => {
    if (!isAquariusPool) return;
    AquariusService.isAquariusConfigured()
      .then((configured) => setAquariusRegistryMissing(!configured))
      .catch(() => setAquariusRegistryMissing(true));
  }, [isAquariusPool]);

  // Fetch actual margin account token balances for the pool's two tokens
  useEffect(() => {
    if (!marginAccountAddress) {
      setMarginDexBalances({});
      return;
    }
    refreshDexMarginBalances();
  }, [marginAccountAddress, refreshDexMarginBalances]);

  // Auto-calculate tokenB when the user types tokenA (and vice versa). reserveA / reserveB match
  // pool.tokens[0] / tokens[1] (see aquarius-utils).
  const poolSpotPriceAinB = (rA: number, rB: number): number => (rA > 0 && rB > 0 ? rB / rA : 0);

  const handleAmountAChange = (val: string) => {
    setAmountA(val);
    const parsed = parseFloat(val);
    if (!isNaN(parsed) && parsed > 0 && reserveA > 0 && reserveB > 0) {
      const ratio = poolSpotPriceAinB(reserveA, reserveB);
      if (ratio > 0) setAmountB((parsed * ratio).toFixed(2));
    } else if (val === "") {
      setAmountB("");
    }
  };

  const handleAmountBChange = (val: string) => {
    setAmountB(val);
    const parsed = parseFloat(val);
    if (!isNaN(parsed) && parsed > 0 && reserveA > 0 && reserveB > 0) {
      const inverseRatio = reserveA / reserveB;
      if (inverseRatio > 0) setAmountA((parsed * inverseRatio).toFixed(2));
    } else if (val === "") {
      setAmountA("");
    }
  };

  const addLiquidityMutation = useMutation({
    mutationFn: async ({ amtA, amtB }: { amtA: number; amtB: number }) => {
      const result = isSoroswapPool
        ? await SoroswapService.addLiquidity(userAddress!, marginAccountAddress!, amtA, amtB, tokenA as SoroswapSwapSymbol, tokenB as SoroswapSwapSymbol)
        : await AquariusService.addLiquidity(userAddress!, marginAccountAddress!, tokenA, tokenB, amtA, amtB);
      if (!result.success) {
        throw new Error(result.error ?? "Add liquidity failed");
      }
      return { ...result, amtA, amtB };
    },
    onMutate: ({ amtA, amtB }) => {
      setTxStatus("loading");
      setTxError("");
      showTxStep(`Adding ${amtA.toFixed(2)} ${tokenALabel} + ${amtB.toFixed(2)} ${tokenBLabel} liquidity to ${dexName}`);
    },
    onSuccess: ({ amtA, amtB }) => {
      setTxStatus("success");
      showTxSuccess("Liquidity added!");
      setMarginDexBalances((prev) => ({
        ...prev,
        [tokenA]: Math.max(0, parseFloat(prev[tokenA] || "0") - amtA).toFixed(2),
        [tokenB]: Math.max(0, parseFloat(prev[tokenB] || "0") - amtB).toFixed(2),
      }));
      setAmountA("");
      setAmountB("");
      setSelectedPctA(0);
      setSelectedPctB(0);
      refreshDexMarginBalances(3, 1500);
      qc.invalidateQueries({ queryKey: ["farm"] });
      qc.invalidateQueries({ queryKey: ["soroswap"] });
    },
    onError: (error) => {
      setTxStatus("error");
      const message = normalizeContractError(error instanceof Error ? error.message : undefined, "Add liquidity failed");
      setTxError(message);
      showTxError(message);
    },
  });

  const handleAddLiquidity = () => {
    if (!userAddress || !marginAccountAddress) return;
    const amtA = parseFloat(amountA);
    const amtB = parseFloat(amountB);
    if (isNaN(amtA) || isNaN(amtB) || amtA <= 0 || amtB <= 0) return;
    addLiquidityMutation.mutate({ amtA, amtB });
  };

  const availableA = marginDexBalances[tokenA] ?? "0";
  const availableB = marginDexBalances[tokenB] ?? "0";
  const isInputValid = parseFloat(amountA) > 0 && parseFloat(amountB) > 0;
  const isOverA = parseFloat(amountA) > parseFloat(availableA);
  const isOverB = parseFloat(amountB) > parseFloat(availableB);
  const isSubmitDisabled = !userAddress || !marginAccountAddress || !isInputValid || isOverA || isOverB || txStatus === "loading";
  const busy = txStatus === "loading" || loadingMarginBalances;

  const buttonText = () => {
    if (!userAddress) return "Connect Wallet";
    if (!marginAccountAddress) return "Margin Account Required";
    if (txStatus === "loading") return "Adding Liquidity...";
    if (!isInputValid) return "Enter Amounts";
    if (isOverA || isOverB) return "Insufficient Balance";
    return `Add ${tokenALabel}/${tokenBLabel} (${dexName})`;
  };

  // Constant-product pools mint shares proportional to the smaller of the two sides' contribution
  // ratio — mirrors how the router itself clamps a lopsided deposit, so this never overstates what
  // a mismatched amountA/amountB pair would actually mint.
  const amtA = parseFloat(amountA) || 0;
  const amtB = parseFloat(amountB) || 0;
  const showEstimate = amtA > 0 && amtB > 0 && reserveA > 0 && reserveB > 0;
  const estimatedShares = totalShares > 0 ? Math.min((amtA / reserveA) * totalShares, (amtB / reserveB) * totalShares) : 0;
  const poolShareAfter = totalShares > 0 ? (estimatedShares / (totalShares + estimatedShares)) * 100 : 100;
  const priceAinB = poolSpotPriceAinB(reserveA, reserveB);
  const priceBinA = reserveA > 0 && reserveB > 0 ? reserveA / reserveB : 0;

  const side = (idx: 0 | 1) => {
    const token = idx === 0 ? tokenA : tokenB;
    const label = idx === 0 ? tokenALabel : tokenBLabel;
    const available = idx === 0 ? availableA : availableB;
    const selected = idx === 0 ? selectedPctA : selectedPctB;
    return (
      <div className="fm-amt" key={token}>
        <div className="fm-amt-t">
          <input
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={idx === 0 ? amountA : amountB}
            disabled={txStatus === "loading"}
            aria-label={`Amount of ${label} to add`}
            onChange={(e) => {
              const sanitized = validateAmountChange(e.target.value);
              if (sanitized === null) return;
              if (idx === 0) handleAmountAChange(sanitized);
              else handleAmountBChange(sanitized);
              setSelectedPctA(0);
              setSelectedPctB(0);
            }}
          />
          <span className="fm-tokp">
            <Icon sym={token} className="fm-ico20" />
            {label}
          </span>
        </div>
        <div className="fm-amt-f" style={{ paddingTop: 8 }}>
          <span className="fm-pcs">
            {DEPOSIT_PERCENTAGES.map((p) => (
              <button
                key={p}
                type="button"
                disabled={busy}
                className={selected === p ? "on" : ""}
                onClick={() => {
                  const bal = parseFloat(available) || 0;
                  const amt = ((bal * p) / 100).toFixed(2);
                  if (idx === 0) {
                    handleAmountAChange(amt);
                    setSelectedPctA(p);
                    setSelectedPctB(0);
                  } else {
                    handleAmountBChange(amt);
                    setSelectedPctB(p);
                    setSelectedPctA(0);
                  }
                }}
              >
                {p}%
              </button>
            ))}
          </span>
          <span className={`fm-maxl num ${(idx === 0 ? isOverA : isOverB) ? "neg" : ""}`} style={{ textDecoration: "none" }}>
            Margin: {loadingMarginBalances ? "..." : `${nf(parseFloat(available) || 0, 2)} ${label}`}
          </span>
        </div>
      </div>
    );
  };

  return (
    <>
      {reserveA > 0 && reserveB > 0 && (
        <div className="fm-amt-u num" style={{ padding: 0 }}>
          1 {tokenALabel} ≈ {priceAinB < 0.01 ? priceAinB.toFixed(4) : priceAinB.toFixed(2)} {tokenBLabel} · 1 {tokenBLabel} ≈ {priceBinA < 0.01 ? priceBinA.toFixed(4) : priceBinA.toFixed(2)} {tokenALabel}
        </div>
      )}
      {side(0)}
      {side(1)}

      {userAddress && !marginAccountAddress && <div className="fm-note">A margin account is required to add liquidity. Please create one in the Margin section.</div>}

      {showEstimate && (
        <div className="fm-pv num">
          <div className="kv">
            <span>Network</span>
            <span>
              <i className="fm-sq" />
              {NETWORK_LABEL}
            </span>
          </div>
          <div className="kv">
            <span>
              You will receive <Info text="Estimated from the pool's live reserves: the smaller of the two sides' share of the pool. The final amount is set when the transaction executes." />
            </span>
            <span>≈ {estimatedShares > 0 ? estimatedShares.toFixed(estimatedShares < 1 ? 6 : 2) : "0"} LP shares</span>
          </div>
          <div className="kv">
            <span>Backed by</span>
            <span>
              {amtA.toFixed(4)} {tokenALabel} + {amtB.toFixed(4)} {tokenBLabel}
            </span>
          </div>
          {totalShares > 0 && (
            <div className="kv">
              <span>Share of pool</span>
              <span>{poolShareAfter < 0.01 ? "<0.01%" : `${poolShareAfter.toFixed(2)}%`}</span>
            </div>
          )}
        </div>
      )}

      {isAquariusPool && aquariusRegistryMissing && (
        <p className="fm-warnn">
          Registry not configured — using default Aquarius addresses. LP position tracking requires the admin to run <code>set_aquarius_router_address</code> and{" "}
          <code>set_aquarius_pool_index</code> on the Registry.
        </p>
      )}
      {isSoroswapPool && <div className="fm-note">LP positions are tracked on-chain from your margin account Soroswap LP token balance.</div>}
      {txError && <p className="fm-warnn dg">{txError}</p>}
      <button type="button" className="fm-cta" disabled={isSubmitDisabled} onClick={handleAddLiquidity}>
        {buttonText()}
      </button>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Aquarius / Soroswap — Remove Liquidity
// ─────────────────────────────────────────────────────────────────────────────

/** The margin account's LP balance in this pool, through the pool's own address / tracking symbol. */
const readLpBalance = (pool: LpPool, marginAccountAddress: string) =>
  pool.kind === "soroswap"
    ? SoroswapService.getLpBalance(marginAccountAddress, pool.cfg.trackingSymbol, pool.cfg.pairAddress)
    : AquariusService.getUserLpBalance(marginAccountAddress, pool.cfg.poolAddress, pool.tokens[0], pool.tokens[1]);

function LpRemovePanel({ pool }: { pool: LpPool }) {
  const { userAddress, marginAccountAddress } = useMarginAddress();
  const qc = useQueryClient();
  const isSoroswapPool = pool.kind === "soroswap";
  const dexName = pool.venue;
  const [tokenA, tokenB] = pool.tokens;
  const [tokenALabel, tokenBLabel] = pool.labels;
  const { reserveA, reserveB, totalShares } = useLpReserves(pool);
  const [value, setValue] = useState("");
  const [selectedPercentage, setSelectedPercentage] = useState(0);
  const [txStatus, setTxStatus] = useState<TxStatus>("idle");
  const [txError, setTxError] = useState("");
  // The margin account's LP balance in this pool (re-read after every farm transaction).
  const lpQuery = useQuery({
    queryKey: ["farm", "v3", "lpBalance", pool.id, marginAccountAddress],
    enabled: Boolean(marginAccountAddress),
    queryFn: () => readLpBalance(pool, marginAccountAddress!),
    staleTime: 4_000,
  });
  const lpBalance = marginAccountAddress ? (lpQuery.data ?? "0") : "0";
  const loadingLpBalance = Boolean(marginAccountAddress) && lpQuery.isLoading;

  const removeMultiDexMutation = useMutation({
    mutationFn: async ({ amount }: { amount: number }) => {
      const result = isSoroswapPool
        ? await SoroswapService.removeLiquidity(userAddress!, marginAccountAddress!, amount, tokenA as SoroswapSwapSymbol, tokenB as SoroswapSwapSymbol)
        : await AquariusService.removeLiquidity(userAddress!, marginAccountAddress!, tokenA, tokenB, amount);
      if (!result.success) {
        throw new Error(result.error ?? "Remove liquidity failed");
      }
      return { ...result, amount };
    },
    onMutate: ({ amount }) => {
      setTxStatus("loading");
      setTxError("");
      showTxStep(`Removing ${amount.toFixed(2)} LP from ${dexName} ${tokenA}/${tokenB}`);
    },
    onSuccess: () => {
      setTxStatus("success");
      showTxSuccess("Liquidity removed!");
      setValue("");
      setSelectedPercentage(0);
      qc.invalidateQueries({ queryKey: ["farm"] });
      qc.invalidateQueries({ queryKey: ["soroswap"] });
      try {
        if (marginAccountAddress) refreshBorrowedBalances(marginAccountAddress);
      } catch (err) {
        console.warn("Post-remove balance refresh failed; ledger tick will reconcile.", err);
      }
      // (The ['farm'] invalidation above also re-reads this panel's LP balance.)
    },
    onError: (error) => {
      setTxStatus("error");
      const errorMsg = normalizeContractError(error instanceof Error ? error.message : undefined, "Remove liquidity failed");
      setTxError(errorMsg);
      showTxError(errorMsg);
    },
  });

  const lpAmount = parseFloat(value);
  const lpAvailable = parseFloat(lpBalance) || 0;
  const isInputValid = lpAmount > 0 && !isNaN(lpAmount);
  // Allow a tiny epsilon (1e-7 = one stroop) so float reformatting like toFixed(2) round-up doesn't
  // tag a legitimate full-balance withdrawal as "exceeds LP balance".
  const isOverBalance = lpAmount > lpAvailable + 1e-7;
  const isSubmitDisabled = !userAddress || !marginAccountAddress || !isInputValid || isOverBalance || txStatus === "loading";

  const handleMultiDexWithdraw = () => {
    if (!userAddress || !marginAccountAddress) return;
    const amount = parseFloat(value);
    if (isNaN(amount) || amount <= 0) return;
    removeMultiDexMutation.mutate({ amount });
  };

  const buttonText = () => {
    if (!userAddress) return "Connect Wallet";
    if (!marginAccountAddress) return "Margin Account Required";
    if (txStatus === "loading") return "Removing Liquidity...";
    if (!isInputValid) return "Enter Amount";
    if (isOverBalance) return "Insufficient LP Balance";
    return `Remove ${tokenALabel}/${tokenBLabel} (${dexName})`;
  };

  // Pro-rata preview of what the entered LP shares redeem for, on the pool's live reserves.
  const ratio = totalShares > 0 && isInputValid && !isOverBalance ? lpAmount / totalShares : 0;
  const outA = ratio * reserveA;
  const outB = ratio * reserveB;

  return (
    <>
      <div className="fm-wpos">
        <span>Your {dexName} LP Balance</span>
        <b className="num">
          <Icon sym={tokenA} className="fm-ico16" />
          <Icon sym={tokenB} className="fm-ico16" />
          {loadingLpBalance ? "..." : `${lpAvailable.toFixed(2)} LP`}
        </b>
      </div>
      <div className="fm-wbox">
        <div className="fm-wi">
          <input
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={value}
            disabled={txStatus === "loading"}
            aria-label="LP shares to remove"
            onChange={(e) => {
              const sanitized = validateAmountChange(e.target.value);
              if (sanitized === null) return;
              setValue(sanitized);
              setSelectedPercentage(0);
            }}
          />
          <span>LP</span>
        </div>
        <div className="fm-amt-u num">
          {isOverBalance ? (
            <span className="neg">Exceeds LP balance</span>
          ) : (
            `~ ${tokFmt(outA, tokenALabel)} + ${tokFmt(outB, tokenBLabel)}`
          )}
        </div>
        <div className="fm-wpcs">
          {PERCENTAGE_OPTIONS.map((p) => (
            <button
              key={p}
              type="button"
              disabled={txStatus === "loading"}
              className={`p${p} ${selectedPercentage === p ? "on" : ""}`}
              onClick={() => {
                setSelectedPercentage(p);
                const balance = parseFloat(lpBalance);
                if (!isNaN(balance) && balance > 0) {
                  // 100% pins to the exact balance string so trailing precision (e.g. lpBalance
                  // "8.8499999" rounded to "8.85" via toFixed(2)) doesn't push us above the cap
                  // and trip "Exceeds LP balance".
                  const next = p === 100 ? lpBalance : ((balance * p) / 100).toFixed(2);
                  setValue(next);
                }
              }}
            >
              {p}%
            </button>
          ))}
        </div>
      </div>
      {ratio > 0 && (
        <div className="fm-pv num">
          <div className="kv">
            <span>
              You receive (est.) <Info text="Pro-rata share of the pool's live reserves; the final amounts are set when the transaction executes." />
            </span>
            <span>
              {tokFmt(outA, tokenALabel)} + {tokFmt(outB, tokenBLabel)} to margin account
            </span>
          </div>
        </div>
      )}
      {userAddress && !marginAccountAddress && <div className="fm-note">A margin account is required to remove liquidity. Please create one in the Margin section.</div>}
      {txError && <p className="fm-warnn dg">{txError}</p>}
      <button type="button" className="fm-cta" disabled={isSubmitDisabled} onClick={handleMultiDexWithdraw}>
        {buttonText()}
      </button>
    </>
  );
}
