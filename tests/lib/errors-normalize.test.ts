import { describe, it, expect } from 'vitest';
import {
  normalizeContractError,
  normalizeSupplyError,
  normalizeWithdrawError,
  normalizeDepositCollateralError,
  normalizeTransferCollateralError,
  normalizeCreateAccountError,
} from '@/lib/errors/normalize';

// The Freighter "Reject" button makes the SDK throw this while parsing the
// (empty) signed response. Every normalizer must read it as a user cancel,
// not leak the raw string to a toast.

const XDR_CANCEL = 'XDR Read Error: attempt to read outside the boundary of the buffer';
const CANCEL_INPUTS = [
  XDR_CANCEL,
  'User declined access',
  'User rejected the request',
  'Transaction was cancelled',
];

describe('cancel detection across every normalizer', () => {
  const cancelMsgs = {
    normalizeContractError: 'Transaction cancelled by user.',
    normalizeSupplyError: 'Transaction cancelled by user.',
    normalizeWithdrawError: 'Transaction cancelled by user.',
    normalizeDepositCollateralError: 'Transaction cancelled by user.',
    normalizeTransferCollateralError: 'Transaction cancelled by user.',
    normalizeCreateAccountError: 'Transaction cancelled by user.',
  };

  for (const input of CANCEL_INPUTS) {
    it(`normalizeContractError → cancel for "${input.slice(0, 24)}…"`, () => {
      expect(normalizeContractError(input)).toBe(cancelMsgs.normalizeContractError);
    });
    it(`normalizeSupplyError → cancel for "${input.slice(0, 24)}…"`, () => {
      expect(normalizeSupplyError(input, 'XLM')).toBe(cancelMsgs.normalizeSupplyError);
    });
    it(`normalizeWithdrawError → cancel for "${input.slice(0, 24)}…"`, () => {
      expect(normalizeWithdrawError(input, 'XLM')).toBe(cancelMsgs.normalizeWithdrawError);
    });
    it(`normalizeDepositCollateralError → cancel for "${input.slice(0, 24)}…"`, () => {
      expect(normalizeDepositCollateralError(input)).toBe(cancelMsgs.normalizeDepositCollateralError);
    });
    it(`normalizeTransferCollateralError → cancel for "${input.slice(0, 24)}…"`, () => {
      expect(normalizeTransferCollateralError(input, 'XLM')).toBe(cancelMsgs.normalizeTransferCollateralError);
    });
    it(`normalizeCreateAccountError → cancel for "${input.slice(0, 24)}…"`, () => {
      expect(normalizeCreateAccountError(input)).toBe(cancelMsgs.normalizeCreateAccountError);
    });
  }
});

describe('non-cancel errors still pass through their domain message', () => {
  it('generic normalization preserves the exact contract code and tx hash', () => {
    const hash = 'a'.repeat(64);
    expect(normalizeContractError(`HostError: Error(Contract, #13) Tx: ${hash}`)).toBe(
      `On-chain contract rejected the transaction (error #13). (Tx: ${hash})`,
    );
  });
  it('supply maps lending-pool contract codes to their contract meaning', () => {
    expect(normalizeSupplyError('HostError: Error(Contract, #6)', 'XLM')).toMatch(/oracle price is stale/i);
  });
  it('withdraw maps insufficient pool liquidity precisely', () => {
    expect(normalizeWithdrawError('Error(Contract, #13)', 'USDC')).toMatch(/enough available liquidity/i);
  });
  it('deposit: contract #10 stays the keep-1-XLM message', () => {
    expect(normalizeDepositCollateralError('Error(Contract, #10)')).toMatch(/keep at least 1 XLM/i);
  });
  it('deposit: missing trustline points to Faucet', () => {
    expect(
      normalizeDepositCollateralError(
        'trustline entry is missing for account GDPMCPUXAHICI4SPGSXG5YXQI2OECTD5A3OCEDKDL3YOOPZ475OSM6YH',
      ),
    ).toMatch(/Faucet/i);
  });
  it('margin deposit preserves AccountManager error meaning', () => {
    expect(normalizeDepositCollateralError('HostError: Error(Contract, #5)')).toMatch(/does not hold/i);
  });
  it('margin transfer preserves unknown exact contract code', () => {
    expect(normalizeTransferCollateralError('HostError: Error(Contract, #77)', 'XLM')).toMatch(/#77/);
  });
  it('transfer: risk-engine block stays informative', () => {
    expect(normalizeTransferCollateralError('is_withdraw_allowed failed', 'USDC')).toMatch(/Risk Engine/i);
  });
  it('create-account: no funds stays the faucet hint', () => {
    expect(normalizeCreateAccountError('account not found on network')).toMatch(/Faucet/i);
  });
});

// Regression: `isCancel` previously bare-matched `includes('rejected')` /
// `includes('declined')`, which also fires on genuine on-chain business-logic
// failures that legitimately use those words (margin-utils.ts's "Borrow
// action rejected for ...", aquarius/blend/soroswap/stellar-utils's
// "Transaction rejected by network"). That silently relabeled real failures
// as "Transaction cancelled by user", hiding the actual reason and making it
// look like the wallet popup was cancelled when the user had confirmed it.
describe('on-chain "rejected"/"declined" failures are not mistaken for a wallet cancel', () => {
  it('a Risk-Engine borrow rejection is not treated as a cancel', () => {
    const msg = normalizeContractError(
      'Borrow action rejected for XLM. This usually means borrow constraints are not satisfied (health factor, debt limit, or collateral requirements).',
    );
    expect(msg).not.toBe('Transaction cancelled by user.');
  });
  it('"Transaction rejected by network" is not treated as a cancel', () => {
    expect(normalizeContractError('Transaction rejected by network')).not.toBe(
      'Transaction cancelled by user.',
    );
  });
  it('an RPC submission "declined" is not treated as a cancel', () => {
    expect(
      normalizeContractError("RPC's submission queue declined this attempt"),
    ).not.toBe('Transaction cancelled by user.');
  });
});
