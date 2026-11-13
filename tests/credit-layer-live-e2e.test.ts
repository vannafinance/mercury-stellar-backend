// Opt-in LIVE end-to-end test of the credit-layer integration. It sends REAL
// testnet transactions through the app's own service code; only the wallet
// signer is replaced by a local key. Skipped unless E2E_SECRET is set:
//   E2E_SECRET=$(stellar keys show <funded testnet key>) npx vitest run tests/credit-layer-live-e2e.test.ts
// The wallet needs ~3,000 XLM plus a little BLUSDC/AQUSDC/SOUSDC (faucets) to cover repay shortfalls.
import { describe, it, expect, vi } from 'vitest';
import * as S from '@stellar/stellar-sdk';

const SECRET = process.env.E2E_SECRET || '';
const kp = SECRET ? S.Keypair.fromSecret(SECRET) : S.Keypair.random();
const ME = kp.publicKey();

vi.mock('@/lib/wallet-adapter', () => ({
  getAddress: async () => ({ address: ME }),
  requestAccess: async () => ({ address: ME }),
  signTransaction: async (xdr: string, opts: { networkPassphrase: string }) => {
    const tx = S.TransactionBuilder.fromXDR(xdr, opts.networkPassphrase);
    tx.sign(kp);
    return { signedTxXdr: tx.toXDR(), signerAddress: ME };
  },
  signMessage: async () => ({}),
  getActiveWalletKind: () => 'freighter',
  setActiveWalletKind: () => {},
}));

const W = (n: number) => (BigInt(Math.round(n * 1e7)) * BigInt(1e11)).toString();
const log = (...a: unknown[]) => console.log('[e2e]', ...a);

describe.skipIf(!SECRET)('credit layer live e2e', () => {
  it('runs every user flow through the app services', async () => {
    const { MarginAccountService: M } = await import('@/lib/margin-utils');
    const { ContractService: C } = await import('@/lib/stellar-utils');
    const { BlendService: B } = await import('@/lib/blend-utils');
    const { SoroswapService: SS } = await import('@/lib/soroswap-utils');
    const { AquariusService: AQ } = await import('@/lib/aquarius-utils');
    const step = async (name: string, p: Promise<any>) => {
      const r = await p;
      log(name, r?.success ? 'OK' : 'FAIL', r?.hash ?? '', r?.error ?? '');
      expect(r?.success, `${name}: ${r?.error}`).toBe(true);
      return r;
    };

    // Earn
    await step('earn supply 500 XLM', C.deposit(ME, 500, 'XLM'));
    log('earn deposited', await C.getDepositedBalance(ME, 'XLM'));
    await step('earn withdraw 100 shares', C.withdraw(ME, 100, 'XLM'));

    // Margin account
    const created = await step('create margin', M.createMarginAccount(ME));
    const margin = created.marginAccountAddress as string;
    expect(await M.discoverExistingAccount(ME)).toBe(margin);
    await step('deposit 2000 XLM', M.depositCollateralTokens(margin, 'XLM', W(2000)));
    await step('borrow 100 SOUSDC', M.borrowTokens(margin, 'SOUSDC', W(100)));
    await step('borrow 30 AQUSDC', M.borrowTokens(margin, 'AQUSDC', W(30)));
    await step('borrow 20 BLUSDC', M.borrowTokens(margin, 'BLUSDC', W(20)));
    log('health', await M.getMarginHealth(margin));

    // Venues
    await step('blend supply 10 USDC', B.depositToBlendPool(ME, margin, 'USDC', 10));
    log('blend usdc', await B.getUserBlendBalance(margin, 'USDC'));
    await step('blend withdraw 5 USDC', B.withdrawFromBlendPool(ME, margin, 'USDC', 5));
    await step('soroswap swap 20 USDC->XLM', SS.swapFromMargin(ME, margin, 'USDC', 20, 'XLM'));
    await step('soroswap add 50 XLM + 10 USDC', SS.addLiquidity(ME, margin, 50, 10, 'XLM', 'USDC'));
    const lp = Number(await SS.getLpBalance(margin));
    log('soroswap lp', lp);
    await step('soroswap remove all LP', SS.removeLiquidity(ME, margin, lp, 'XLM', 'USDC'));
    await step('aquarius swap 10 XLM->AQUSDC', AQ.aquariusSwapFromMargin(ME, margin, 'XLM' as any, 10, 'USDC' as any));
    await step('aquarius add 20 XLM + 1 AQUSDC', AQ.addLiquidity(ME, margin, 'XLM', 'USDC', 20, 1));
    const share = Number(await AQ.getLpBalance(margin, 'XLM', 'USDC'));
    log('aquarius share', share);
    // Protocol 30 regression (2026-11-13): with an Aquarius LP share held, every health check reads
    // Aquarius pool storage whose keys carry ScValType 22; @stellar/stellar-sdk 14 could not decode
    // the simulation, so borrow / withdraw failed while deposit (no health check) worked.
    await step('borrow 5 BLUSDC while holding Aquarius LP', M.borrowTokens(margin, 'BLUSDC', W(5)));
    await step('borrow 20 XLM while holding Aquarius LP', M.borrowTokens(margin, 'XLM', W(20)));
    await step('withdraw 10 XLM while holding Aquarius LP', M.withdrawCollateralBalance(margin, 'XLM', W(10)));
    log('health with Aquarius LP', await M.getMarginHealth(margin));
    await step('aquarius remove all', AQ.removeLiquidity(ME, margin, 'XLM', 'USDC', share));

    log('collateral', JSON.stringify((await M.getCollateralBalances(margin)).data));
    log('debts', JSON.stringify((await M.getCurrentBorrowedBalances(margin)).data));

    // Close out: repay every debt (shortfall comes from the wallet), withdraw some XLM
    await step('repay SOUSDC max', M.repayLoan(margin, 'SOUSDC', W(1000)));
    await step('repay AQUSDC max', M.repayLoan(margin, 'AQUSDC', W(1000)));
    await step('repay BLUSDC max', M.repayLoan(margin, 'BLUSDC', W(1000)));
    await step('repay XLM max', M.repayLoan(margin, 'XLM', W(1000)));
    await step('withdraw 500 XLM', M.withdrawCollateralBalance(margin, 'XLM', W(500)));
    const h = await M.getMarginHealth(margin);
    log('final health', h);
    expect(h?.debtUsd).toBe(0);
  }, 900_000);
});
