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
vi.mock('@/lib/protocol-config', () => ({
  getProtocolConfig: vi.fn(),
  getBlendPoolAddress: vi.fn(),
  getXlmAddress: vi.fn(),
  getUsdcAddress: vi.fn(),
  fallbackXlmAddress: vi.fn(() => 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'),
  fallbackUsdcAddress: vi.fn(() => 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU'),
}));

import { MarginAccountService } from '@/lib/margin-utils';

const svc = MarginAccountService as unknown as Record<string, (...args: unknown[]) => string>;

// ─────────────────────────────────────────────────────────────────────────────
// normalizeContractTokenSymbol
// ─────────────────────────────────────────────────────────────────────────────
describe('MarginAccountService.normalizeContractTokenSymbol', () => {
  const normalize = (s: string) => svc['normalizeContractTokenSymbol'](s);

  it('maps BLUSDC → USDC', () => expect(normalize('BLUSDC')).toBe('USDC'));
  // BLEND_USDC is a Blend tracking receipt symbol — must not collapse to USDC.
  it('passes through BLEND_USDC tracking symbol', () => expect(normalize('BLEND_USDC')).toBe('BLEND_USDC'));
  it('maps USDC → USDC', () => expect(normalize('USDC')).toBe('USDC'));
  it('maps AQUARIUS_USDC → USDC', () => expect(normalize('AQUARIUS_USDC')).toBe('USDC'));
  it('maps AQUSDC → USDC', () => expect(normalize('AQUSDC')).toBe('USDC'));
  it('maps SOROSWAP_USDC → USDC', () => expect(normalize('SOROSWAP_USDC')).toBe('USDC'));
  it('maps SOUSDC → USDC', () => expect(normalize('SOUSDC')).toBe('USDC'));
  it('passes through BLEND_XLM tracking symbol', () => expect(normalize('BLEND_XLM')).toBe('BLEND_XLM'));
  it('passes through AQ_XLM_USDC tracking symbol', () => expect(normalize('AQ_XLM_USDC')).toBe('AQ_XLM_USDC'));
  it('passes through SS_XLM_USDC tracking symbol', () => expect(normalize('SS_XLM_USDC')).toBe('SS_XLM_USDC'));
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
    expect(msg).toMatch(/resource limits/i);
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

  it('formats repay ArithDomain error with debt hint', () => {
    const msg = fmt('Error(Object, ArithDomain) in u256_sub', 'repay');
    expect(msg).toMatch(/outstanding debt/i);
  });

  it('formats repay HostError generically', () => {
    const msg = fmt('HostError occurred', 'repay');
    expect(msg).toMatch(/failed on-chain/i);
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
