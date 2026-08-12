import { describe, it, expect } from 'vitest';
import {
  normalizeContractError,
  normalizeSupplyError,
  normalizeWithdrawError,
  normalizeDepositCollateralError,
  normalizeTransferCollateralError,
  normalizeCreateAccountError,
  isUnfundedWalletError,
  unfundedWalletMessage,
} from '@/lib/errors/normalize';
import { humanizeMcpWriteError } from '@/lib/copilot/mcp-write';
import { humanizeLegError } from '@/lib/copilot/multi-leg-agent';

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
  it('transfer: risk-engine block stays informative', () => {
    expect(normalizeTransferCollateralError('is_withdraw_allowed failed', 'USDC')).toMatch(/Risk Engine/i);
  });
  it('create-account: no funds stays the faucet hint', () => {
    expect(normalizeCreateAccountError('account not found on network')).toMatch(/Faucet/i);
  });
});

describe('unfunded wallet is detected however the RPC phrases it', () => {
  const raws = [
    // MCP `vanna_open_account`, verbatim from the copilot NOTE card
    "Failed to load account 'GAHZRNY32C3ME2SFSAQXUS7SL2AQ44SZBJTWW6MZ2R56JXRZ43E7YEPS': Account not found, account_id: GAHZRNY32C3ME2SFSAQXUS7SL2AQ44SZBJTWW6MZ2R56JXRZ43E7YEPS",
    // stellar-sdk getAccount on the margin page
    'Account not found: GAHZRNY32C3ME2SFSAQXUS7SL2AQ44SZBJTWW6MZ2R56JXRZ43E7YEPS',
    'account not found on network',
    'Request failed: op_underfunded',
    'tx_INSUFFICIENT_BALANCE',
  ];
  for (const raw of raws) {
    it(`detects "${raw.slice(0, 34)}…"`, () => {
      expect(isUnfundedWalletError(raw)).toBe(true);
    });
  }

  it('does not fire on unrelated failures', () => {
    for (const raw of [
      'Error(Contract, #10)',
      'trustline entry is missing for account GDPM…',
      'rejected by risk engine pre-flight',
      'fetch failed',
      '',
      undefined,
    ]) {
      expect(isUnfundedWalletError(raw)).toBe(false);
    }
  });

  it('names the fee, the reserve and the Faucet, and tails the caller action', () => {
    const msg = unfundedWalletMessage('open your margin account');
    expect(msg).toMatch(/transaction fee/i);
    expect(msg).toMatch(/1 XLM/);
    expect(msg).toMatch(/Faucet/);
    expect(msg).toMatch(/open your margin account\.$/);
  });

  it('falls back to a neutral action when the caller has no context', () => {
    expect(unfundedWalletMessage()).toMatch(/try again\.$/);
  });

  it('routes the copilot single-write path to the same message', () => {
    const msg = humanizeMcpWriteError(
      {
        error: 'contract_error',
        message:
          "Failed to load account 'GAHZRNY32C3ME2SFSAQXUS7SL2AQ44SZBJTWW6MZ2R56JXRZ43E7YEPS': Account not found",
      },
      'vanna_open_account',
    );
    expect(msg).toBe(unfundedWalletMessage('open your margin account'));
  });

  it('routes a strategy leg to the same message', () => {
    expect(humanizeLegError('Account not found, account_id: GAHZ…')).toBe(unfundedWalletMessage());
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
