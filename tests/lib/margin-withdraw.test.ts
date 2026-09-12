import { describe, expect, it } from 'vitest';
import { maxMarginWithdrawal, marginWithdrawalPreset } from '@/lib/utils/margin-withdraw';
import { computeCollateralPreviewRows } from '@/lib/utils/margin-preview';
import { decimalAmountToWad } from '@/lib/utils/sanitize-amount';
import { normalizeTransferCollateralError } from '@/lib/errors/normalize';

describe('margin collateral withdrawal after repayment', () => {
  it('withdraws the complete 1000 XLM balance from the reported debt-free account', () => {
    const max = maxMarginWithdrawal(1000, 0, 999, 0.18108);
    const amount = marginWithdrawalPreset('1000.0000000', max);
    expect(amount).toBe('1000');
    expect(decimalAmountToWad(amount)).toBe(BigInt(1000) * BigInt(10) ** BigInt(18));
    const rows = computeCollateralPreviewRows({ totalCollateralValue: 181.08, totalBorrowedValue: 0, avgHealthFactor: 999, transferUsd: Number(amount) * 0.18108, isInbound: false });
    expect(rows.find(r => r.label === 'Liquidation Buffer')).toMatchObject({ after: 'N/A — no debt', tone: 'default' });
    expect(rows.find(r => r.label === 'Health Factor')).toMatchObject({ before: '∞', after: '∞' });
  });

  it.each(['0.0000001', '8.0000000', '11495.6516647', '199.9500001'])('does not strand tokens or round up Max for %s', balance => {
    const amount = marginWithdrawalPreset(balance, maxMarginWithdrawal(Number(balance), 0, 999, 1));
    expect(decimalAmountToWad(amount)).toBe(decimalAmountToWad(balance));
  });

  it('floors partial percentages at token precision', () => {
    expect(marginWithdrawalPreset('1.0000001', 1.0000001, 50)).toBe('0.5');
  });

  it('keeps the projected health factor strictly above 1.1 when debt remains', () => {
    const debt = 100, hf = 2, price = 1;
    const amount = Number(marginWithdrawalPreset('200', maxMarginWithdrawal(200, debt, hf, price)));
    expect((hf * debt - amount * price) / debt).toBeGreaterThan(1.1);
    expect(amount).toBeLessThan(90);
  });

  it('does not treat a sub-cent remaining liability as zero debt', () => {
    const max = maxMarginWithdrawal(1000, 0.001, 1.1, 1);
    expect(max).toBe(0);
    const rows = computeCollateralPreviewRows({ totalCollateralValue: 0.0011, totalBorrowedValue: 0.001, avgHealthFactor: 1.1, transferUsd: 0, isInbound: false });
    expect(rows.find(r => r.label === 'Liquidation Buffer')?.after).not.toContain('no debt');
  });

  it('does not invent a reserve or safe retry amount for a failed withdrawal', () => {
    const message = normalizeTransferCollateralError('Withdraw transaction failed on-chain', 'XLM', { isFullWithdraw: true, maxExecutableWithdraw: 1000 });
    expect(message).not.toMatch(/reserve|smaller|locked|1000/);
  });
});
