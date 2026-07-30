/**
 * Centralised Soroban / contract error normalization.
 *
 * All "raw error → human message" translation lives here so components
 * never duplicate these patterns. Each exported function receives a raw
 * error string (or undefined) and returns a user-facing message.
 */

// ─── shared detection helpers ────────────────────────────────────────────────

function isCancel(text: string): boolean {
  return (
    text.includes('cancelled') ||
    text.includes('canceled') ||
    text.includes('rejected by user') ||
    text.includes('user denied') ||
    text.includes('declined') ||
    text.includes('rejected') ||
    // Freighter sometimes throws an XDR parse error when the user hits
    // "Reject" — the wallet closes before the SDK can read the response.
    text.includes('xdr read error') ||
    text.includes('boundary of the buffer')
  );
}

function isInsufficientBalance(text: string): boolean {
  return (
    text.includes('insufficient') ||
    text.includes('underfunded') ||
    text.includes('insufficientbalance') ||
    text.includes('balance is not sufficient') ||
    text.includes('resulting balance is not within')
  );
}

function isSorobanRpcError(text: string): boolean {
  return (
    text.includes('diagnostic event') ||
    text.includes('hosterror') ||
    text.includes('sorobanrpcerror') ||
    text.includes('transaction failed') ||
    text.includes('error(contract')
  );
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Normalize a generic Soroban contract error. Used as a fallback in all
 * domain-specific normalizers below.
 */
export function normalizeContractError(
  raw: string | undefined,
  fallback = 'Transaction failed. Please try again.',
): string {
  if (!raw) return fallback;
  const text = raw.replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();

  if (isCancel(lower)) return 'Transaction cancelled by user.';
  if (isSorobanRpcError(lower)) return fallback;

  return text.length > 200 ? `${text.slice(0, 200)}...` : text || fallback;
}

/** Normalize earn supply (deposit) errors. */
export function normalizeSupplyError(
  raw: string | undefined,
  asset: string,
): string {
  const fallback = `Failed to supply ${asset}. Please try again.`;
  if (!raw) return fallback;
  const text = raw.replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();

  if (isCancel(lower)) return 'Transaction cancelled by user.';
  if (isInsufficientBalance(lower))
    return `You cannot supply all your ${asset}. Keep a small balance and try again.`;
  if (isSorobanRpcError(lower))
    return `Supply failed for ${asset}. Please reduce the amount and try again.`;

  return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}

/** Normalize earn withdraw (redeem) errors. */
export function normalizeWithdrawError(
  raw: string | undefined,
  asset: string,
): string {
  const fallback = `Failed to withdraw ${asset}. Please try again.`;
  if (!raw) return fallback;
  const text = raw.replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();

  if (isCancel(lower)) return 'Transaction cancelled by user.';
  if (isInsufficientBalance(lower))
    return `You cannot withdraw all your v${asset}. Keep a small balance and try again.`;
  if (isSorobanRpcError(lower))
    return `Withdraw failed for ${asset}. Please reduce the amount and try again.`;

  return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}

/** Normalize margin collateral deposit errors (from leverage-assets-tab). */
export function normalizeDepositCollateralError(raw: string | undefined): string {
  const compact = (raw ?? '').split('\nEvent log')[0]?.trim() ?? '';
  const lower = compact.toLowerCase();

  if (isCancel(lower)) return 'Transaction cancelled by user.';
  if (
    lower.includes('error(contract, #10)') ||
    lower.includes('resulting balance is not within the allowed range')
  ) {
    return 'You cannot deposit 100% of your wallet balance. Please keep at least 1 XLM in your wallet.';
  }
  if (lower.includes('insufficient')) return 'Insufficient wallet balance for this deposit.';
  if (lower.includes('trustline entry is missing')) {
    return 'Your wallet is missing the USDC trustline required to deposit BLUSDC. Open the Faucet, mint Blend USDC, then retry.';
  }
  if (lower.includes('hosterror'))
    return 'Deposit failed on-chain. Please retry with a slightly smaller amount.';

  return compact || 'Deposit and borrow failed. Please try again.';
}

/** Normalize margin collateral transfer/withdraw errors (from transfer-collateral). */
export function normalizeTransferCollateralError(
  raw: string | undefined,
  asset: string,
  opts: {
    maxSafe?: number;
    isFullWithdraw?: boolean;
    maxExecutableWithdraw?: number;
    xlmBuffer?: number;
  } = {},
): string {
  const compact = (raw ?? '').split('\nEvent log')[0]?.trim() ?? '';
  const lower = compact.toLowerCase();

  if (isCancel(lower)) return 'Transaction cancelled by user.';
  if (
    lower.includes('error(contract, #10)') ||
    lower.includes('resulting balance is not within the allowed range')
  ) {
    return 'You cannot transfer all your wallet balance. Please keep at least 1 XLM in your wallet.';
  }

  if (
    lower.includes('invalidaction') ||
    lower.includes('is_withdraw_allowed') ||
    lower.includes('unreachablecodereached')
  ) {
    if (typeof opts.maxSafe === 'number' && opts.maxSafe > 0)
      return `Withdrawal blocked by Risk Engine. Max transferable right now: ${opts.maxSafe.toFixed(2)} ${asset}.`;
    return 'Withdrawal blocked by Risk Engine. Repay some debt first, then try again.';
  }

  if (lower.includes('insufficient')) return 'Insufficient balance for this transfer.';

  if (
    lower.includes('withdraw transaction failed on-chain') ||
    lower.includes('withdraw collateral failed with status')
  ) {
    if (opts.isFullWithdraw && typeof opts.xlmBuffer === 'number' && typeof opts.maxExecutableWithdraw === 'number') {
      return `~${opts.xlmBuffer} XLM stay locked in the margin account as Stellar base reserve. You can withdraw at most ${opts.maxExecutableWithdraw.toFixed(2)} XLM.`;
    }
    if (typeof opts.maxSafe === 'number' && opts.maxSafe > 0)
      return `Withdrawal failed on-chain. Max transferable right now: ${opts.maxSafe.toFixed(2)} ${asset}.`;
    return 'Withdrawal failed on-chain. Please retry with a slightly smaller amount.';
  }

  if (lower.includes('hosterror')) {
    if (opts.isFullWithdraw && typeof opts.maxExecutableWithdraw === 'number')
      return `Full withdrawal can fail due to on-chain rounding/state dust. Try up to ${opts.maxExecutableWithdraw.toFixed(2)} ${asset}.`;
    return 'Transfer failed on-chain. Please retry in a moment.';
  }

  return compact || 'Transfer failed. Please try again.';
}

/** Normalize margin account creation errors (from leverage-assets-tab). */
export function normalizeCreateAccountError(msg: string): string {
  const m = (msg ?? '').toLowerCase();
  if (!m) return 'Failed to create margin account. Please try again.';
  if (isCancel(m)) return 'Transaction cancelled by user.';
  if (m.includes('account not found') || m.includes('not found on network'))
    return 'Wallet has no XLM on testnet. Open the Faucet and fund your wallet, then try again.';
  if (m.includes('insufficient') || m.includes('balance') || m.includes('fee'))
    return "Wallet doesn't have enough XLM to pay the transaction fee. Use the Faucet to fund it, then try again.";
  return 'Failed to create margin account. Please try again.';
}
