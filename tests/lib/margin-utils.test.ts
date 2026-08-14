import { describe, it, expect, vi } from 'vitest';

// Mock network-bound imports so we can test pure helpers in isolation
vi.mock('@stellar/stellar-sdk', () => ({ default: {}, rpc: {}, xdr: {} }));
vi.mock('@stellar/freighter-api', () => ({ getAddress: vi.fn(), signTransaction: vi.fn() }));
vi.mock('@/lib/analytics/stellar/farmTrackingCollateral', () => ({
  mergeFarmTrackingCollateralIntoBalances: vi.fn(),
}));
vi.mock('@/lib/oracle-price', () => ({
  fetchTokenPrice: vi.fn(),
  getCachedTokenPrice: vi.fn(),
}));
vi.mock('@/lib/blend-utils', () => ({ BlendService: {} }));

import { MarginAccountService } from '@/lib/margin-utils';

const svc = MarginAccountService as unknown as Record<string, (...args: unknown[]) => string>;

// ─────────────────────────────────────────────────────────────────────────────
// normalizeContractTokenSymbol
// ─────────────────────────────────────────────────────────────────────────────
describe('MarginAccountService.normalizeContractTokenSymbol', () => {
  const normalize = (s: string) => svc['normalizeContractTokenSymbol'](s);

  it('maps BLUSDC → USDC', () => expect(normalize('BLUSDC')).toBe('USDC'));
  it('maps BLEND_USDC → USDC', () => expect(normalize('BLEND_USDC')).toBe('USDC'));
  it('maps USDC → USDC', () => expect(normalize('USDC')).toBe('USDC'));
  it('maps AQUARIUS_USDC → AQUSDC', () => expect(normalize('AQUARIUS_USDC')).toBe('AQUSDC'));
  it('maps AQUSDC → AQUSDC', () => expect(normalize('AQUSDC')).toBe('AQUSDC'));
  it('maps SOROSWAP_USDC → SOUSDC', () => expect(normalize('SOROSWAP_USDC')).toBe('SOUSDC'));
  it('maps SOUSDC → SOUSDC', () => expect(normalize('SOUSDC')).toBe('SOUSDC'));
  it('uppercases unrecognised symbols', () => expect(normalize('xlm')).toBe('XLM'));
});

// ─────────────────────────────────────────────────────────────────────────────
// parseBorrowNotAllowedMessage
// ─────────────────────────────────────────────────────────────────────────────
describe('MarginAccountService.parseBorrowNotAllowedMessage', () => {
  const parse = (raw: string, token: string) =>
    svc['parseBorrowNotAllowedMessage'](raw, token);

  it('detects is_borrow_allowed:false and mentions collateral', () => {
    const msg = parse('is_borrow_allowed:false', 'XLM');
    expect(msg).toMatch(/collateral/i);
  });

  it('detects "Borrowing is not allowed" phrase', () => {
    const msg = parse('Borrowing is not allowed for this user', 'USDC');
    expect(msg).toMatch(/collateral/i);
  });

  it('detects price not available → oracle error', () => {
    const msg = parse('price not available for asset', 'XLM');
    expect(msg).toMatch(/oracle/i);
  });

  it('detects missing trustline → pool config error', () => {
    const msg = parse('trustline entry is missing for account GABCD', 'XLM');
    expect(msg).toMatch(/trustline/i);
  });

  it('detects Budget/resource limit error', () => {
    const msg = parse('Budget exceeded ExceededLimit', 'XLM');
    expect(msg).toMatch(/budget exceeded/i);
  });

  it('detects InvalidAction / UnreachableCodeReached', () => {
    const msg = parse('InvalidAction code triggered', 'USDC');
    expect(msg).toMatch(/constraints/i);
  });

  it('returns generic fallback for unknown error', () => {
    const msg = parse('some completely unknown error', 'XLM');
    expect(msg).toMatch(/collateral|retry/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatUserFacingContractError
// ─────────────────────────────────────────────────────────────────────────────
describe('MarginAccountService.formatUserFacingContractError', () => {
  const fmt = (raw: string, action: string) =>
    svc['formatUserFacingContractError'](raw, action);

  it('formats repay ArithDomain error as an insufficient-balance message', () => {
    const msg = fmt('Error(Object, ArithDomain) in u256_sub', 'repay');
    expect(msg).toMatch(/insufficient balance/i);
  });

  it('formats repay HostError generically', () => {
    const msg = fmt('HostError occurred', 'repay');
    expect(msg).toMatch(/failed on-chain/i);
  });

  // Regression: confirmed live as `HostError: Error(WasmVm, InvalidAction)` —
  // collect_from returns false, then AccountManager still calls
  // remove_borrowed_token_balance, which underflows and panics. That detail
  // only exists in the "Event log" section, which this function's `compact`
  // (used for the plain fallback) strips off before pattern-matching — so
  // checking against `compact` here silently never matched, and this real
  // insufficient-balance repay fell through to the generic "failed on-chain"
  // message instead.
  it('recognizes a real insufficient-margin-account-balance repay failure buried in the Event log', () => {
    const raw = [
      'HostError: Error(WasmVm, InvalidAction)',
      '',
      'Event log (newest first):',
      '   1: [Diagnostic Event] topics:[error, Error(WasmVm, InvalidAction)], data:["contract call failed", remove_borrowed_token_balance, [USDC, 15920235423598650494]]',
      '   8: [Diagnostic Event] topics:[fn_return, collect_from], data:false',
    ].join('\n');
    const msg = fmt(raw, 'repay');
    expect(msg).toMatch(/insufficient balance/i);
  });

  it('formats withdraw is_withdraw_allowed=false with Risk Engine hint', () => {
    const msg = fmt('is_withdraw_allowed returned false', 'withdraw');
    expect(msg).toMatch(/Risk Engine/i);
  });

  it('formats withdraw insufficient balance', () => {
    const msg = fmt('insufficient collateral balance', 'withdraw');
    expect(msg).toMatch(/[Ii]nsufficient/);
  });

  it('truncates long generic errors to 220 chars + ellipsis', () => {
    const longError = 'A'.repeat(300);
    const msg = fmt(longError, 'generic');
    expect(msg.endsWith('...')).toBe(true);
    expect(msg.length).toBeLessThanOrEqual(224); // 220 + '...' length
  });

  it('formats generic HostError', () => {
    const msg = fmt('HostError: something went wrong', 'generic');
    expect(msg).toMatch(/failed on-chain/i);
  });
});
