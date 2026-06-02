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
  'Request rejected',
  'Transaction was cancelled',
];

describe('cancel detection across every normalizer', () => {
  const cancelMsgs = {
    normalizeContractError: 'Transaction cancelled by user.',
    normalizeSupplyError: 'Transaction cancelled by user.',
    normalizeWithdrawError: 'Transaction cancelled by user.',
    normalizeDepositCollateralError: 'Transaction cancelled by user.',
    normalizeTransferCollateralError: 'Transaction cancelled by user.',
    normalizeCreateAccountError: 'Transaction was cancelled in Freighter.',
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
  it('deposit: contract #10 stays the keep-1-XLM message', () => {
    expect(normalizeDepositCollateralError('Error(Contract, #10)')).toMatch(/keep at least 1 XLM/i);
  });
  it('transfer: risk-engine block stays informative', () => {
    expect(normalizeTransferCollateralError('is_withdraw_allowed failed', 'USDC')).toMatch(/Risk Engine/i);
  });
  it('create-account: no funds stays the faucet hint', () => {
    expect(normalizeCreateAccountError('account not found on network')).toMatch(/Faucet/i);
  });
});
