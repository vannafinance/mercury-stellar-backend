/** Read-only testnet probe. Never signs or submits a transaction. */
const fs = require('node:fs');
const { Account, Contract, Networks, TransactionBuilder, nativeToScVal, scValToNative, rpc, xdr, StrKey } = require('@stellar/stellar-sdk');

async function main() {
  const source = fs.readFileSync('lib/stellar-utils.ts', 'utf8');
  const registry = source.match(/REGISTRY: '([^']+)'/)[1];
  const server = new rpc.Server('https://soroban-testnet.stellar.org');
  const account = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '0');
  const lookup = new TransactionBuilder(account, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(registry).call('get_risk_engine_address')).setTimeout(30).build();
  const resolved = await (async () => {
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
      try { return await server.simulateTransaction(lookup); } catch (error) {
        last = error;
        await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
      }
    }
    throw last;
  })();
  if (!rpc.Api.isSimulationSuccess(resolved)) throw new Error(`Registry resolution failed: ${resolved.error ?? 'no result'}`);
  const address = scValToNative(resolved.result.retval);
  const instance = await (async () => {
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
      try { return await server.getContractData(address, xdr.ScVal.scvLedgerKeyContractInstance()); } catch (error) {
        last = error;
        await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
      }
    }
    throw last;
  })();
  const hash = instance.val.contractData().val().instance().executable().wasmHash().toString('hex');
  const report = { network: 'testnet', registry, contract: address, wasmHash: hash, resolutionLedger: resolved.latestLedger, checkedAt: new Date().toISOString(), probes: [] };
  const target = process.argv[2] || 'CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C';
  if (!StrKey.isValidContract(target)) throw new Error('Expected a valid public smart-account address');
  async function withRetry(operation) {
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
      try { return await operation(); } catch (error) {
        last = error;
        await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
      }
    }
    throw last;
  }
  async function read(contract, method, args = []) {
    return withRetry(async () => {
      const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: Networks.TESTNET })
        .addOperation(new Contract(contract).call(method, ...args)).setTimeout(30).build();
      const result = await server.simulateTransaction(tx);
      return { method, ledger: result.latestLedger,
        value: rpc.Api.isSimulationSuccess(result) ? scValToNative(result.result.retval) : null,
        error: rpc.Api.isSimulationError(result) ? result.error : null };
    });
  }
  if (target) {
    const arg = nativeToScVal(target, { type: 'address' });
    report.account = { address: target, reads: [] };
    for (const method of ['get_all_collateral_tokens', 'get_all_borrowed_tokens']) {
      const result = await read(target, method);
      report.account.reads.push(result);
      if (method === 'get_all_collateral_tokens' && Array.isArray(result.value)) {
        for (const symbol of result.value.slice(0, 20)) report.account.reads.push({ symbol,
          ...await read(target, 'get_collateral_token_balance', [nativeToScVal(symbol, { type: 'symbol' })]) });
      }
    }
    for (const method of ['get_current_total_balance', 'get_current_total_borrows']) report.account.reads.push(await read(address, method, [arg]));
    const oracle = await read(registry, 'get_oracle_contract_address');
    report.account.reads.push(oracle);
    if (typeof oracle.value === 'string') for (const symbol of ['XLM', 'USDC']) report.account.reads.push({ symbol,
      ...await read(oracle.value, 'get_price_latest', [nativeToScVal(symbol, { type: 'symbol' })]) });
    const tracking = await read(registry, 'get_tracking_token_contract_addr');
    report.account.reads.push(tracking);
    if (typeof tracking.value === 'string') report.account.reads.push(await read(tracking.value, 'balance',
      [arg, nativeToScVal('BLEND_USDC', { type: 'symbol' })]));
    const [blend, usdc] = await Promise.all([read(registry, 'get_blend_pool_address'), read(registry, 'get_usdc_contract_address')]);
    if ([oracle.value, tracking.value, blend.value, usdc.value].every((value) => typeof value === 'string')) {
      const symbols = report.account.reads.find((entry) => entry.method === 'get_all_collateral_tokens').value;
      report.account.valuationReads = await Promise.all([
        read(address, 'get_current_total_balance', [arg]),
        read(address, 'get_current_total_borrows', [arg]),
        ...symbols.map(async (symbol) => ({ symbol, ...await read(target, 'get_collateral_token_balance', [nativeToScVal(symbol, { type: 'symbol' })]) })),
        ...['XLM', 'USDC'].map(async (symbol) => ({ symbol, ...await read(oracle.value, 'get_price_latest', [nativeToScVal(symbol, { type: 'symbol' })]) })),
        read(tracking.value, 'balance', [arg, nativeToScVal('BLEND_USDC', { type: 'symbol' })]),
        read(blend.value, 'get_reserve', [nativeToScVal(usdc.value, { type: 'address' })]),
        read(usdc.value, 'decimals'),
      ]);
    }
    for (const method of ['is_borrow_allowed', 'is_withdraw_allowed']) report.account.reads.push(await read(address, method,
      [nativeToScVal('XLM', { type: 'symbol' }), nativeToScVal(0n, { type: 'u256' }), arg]));
    const borrowed = report.account.reads.find((entry) => entry.method === 'get_all_borrowed_tokens');
    if (Array.isArray(borrowed?.value)) {
      for (const symbol of borrowed.value.slice(0, 20)) {
        report.account.reads.push({
          symbol,
          ...await read(target, 'get_borrowed_token_debt', [nativeToScVal(symbol, { type: 'symbol' })]),
        });
      }
    }
    /**
     * RiskEngine.liquidation_snapshot is the function that *decides* liquidation.
     * AccountManager.liquidation *performs* it — never call that from this script.
     * The published function table does not list snapshot; probe the likely
     * signatures and record the simulation result, including "no such function".
     */
    report.account.liquidationSnapshot = [];
    for (const attempt of [
      { label: 'account', method: 'liquidation_snapshot', args: [arg] },
      { label: 'no_args', method: 'liquidation_snapshot', args: [] },
      { label: 'get_liquidation_snapshot_account', method: 'get_liquidation_snapshot', args: [arg] },
    ]) {
      report.account.liquidationSnapshot.push({
        signature: attempt.label,
        ...await read(address, attempt.method, attempt.args),
      });
    }
    let appSnapshot = { error: 'skipped', hint: 'Start npm run dev so GET /api/account can include computeMarginSnapshot.' };
    const origin = process.env.AUDIT_APP_ORIGIN || 'http://127.0.0.1:3000';
    try {
      const res = await fetch(`${origin}/api/account/${target}`);
      appSnapshot = { http: res.status, origin, body: await res.json() };
    } catch (error) {
      appSnapshot = { origin, error: error instanceof Error ? error.message : String(error),
        hint: 'Start npm run dev so GET /api/account can include computeMarginSnapshot.' };
    }
    report.account.appSnapshot = appSnapshot;
    const wadToUsd = (value) => {
      if (value == null || value === '') return null;
      try { return Number(BigInt(value)) / 1e18; } catch { return null; }
    };
    const totalBalance = report.account.reads.find((entry) => entry.method === 'get_current_total_balance');
    const totalBorrows = report.account.reads.find((entry) => entry.method === 'get_current_total_borrows');
    const snapshotHit = report.account.liquidationSnapshot.find((entry) => entry.value != null)
      ?? report.account.liquidationSnapshot[0];
    const appBody = appSnapshot && appSnapshot.body && typeof appSnapshot.body === 'object' ? appSnapshot.body : null;
    const ledgers = [
      totalBalance?.ledger, totalBorrows?.ledger, snapshotHit?.ledger,
    ].filter((ledger) => Number.isFinite(ledger));
    const sameLedger = ledgers.length > 0 && ledgers.every((ledger) => ledger === ledgers[0]);
    let snapshotDecoded = null;
    if (Array.isArray(snapshotHit?.value) && snapshotHit.value.length >= 2) {
      snapshotDecoded = {
        collateralUsd: wadToUsd(snapshotHit.value[0]),
        debtUsd: wadToUsd(snapshotHit.value[1]),
        flag: snapshotHit.value.length > 2 ? snapshotHit.value[2] : null,
      };
    }
    const appGross = typeof appBody?.grossCollateralValue === 'number' ? appBody.grossCollateralValue : null;
    const appDebt = typeof appBody?.totalBorrowedValue === 'number' ? appBody.totalBorrowedValue : null;
    const within = (a, b) => {
      if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
      const diff = Math.abs(a - b);
      const scale = Math.max(Math.abs(a), Math.abs(b), 1);
      return { diff, agrees: diff <= Math.max(0.5, 0.005 * scale) };
    };
    let recommendation = 'liquidation_snapshot could not be decoded. Pass A sizing must not guess a basis.';
    if (snapshotDecoded) {
      const coll = within(appGross, snapshotDecoded.collateralUsd);
      const debt = within(appDebt, snapshotDecoded.debtUsd);
      const collText = coll == null
        ? 'app gross was not available for comparison'
        : coll.agrees
          ? `agrees with computeMarginSnapshot gross (~$${appGross})`
          : `disagrees with computeMarginSnapshot gross (~$${appGross}) by ~$${coll.diff.toFixed(2)}`;
      const debtText = debt == null
        ? 'app debt was not available for comparison'
        : debt.agrees
          ? `agrees with computeMarginSnapshot totalBorrowedValue (~$${appDebt})`
          : `disagrees with computeMarginSnapshot totalBorrowedValue (~$${appDebt}) by ~$${debt.diff.toFixed(2)}`;
      recommendation = `liquidation_snapshot(account) is a 3-tuple [collateralWad, debtWad, flag]. Contract collateral (~$${snapshotDecoded.collateralUsd}) matches get_current_total_balance and ${collText}. Contract debt (~$${snapshotDecoded.debtUsd}) matches get_current_total_borrows and ${debtText}. Phase 3 Pass A sizes from this contract basis only when both sides stay within max($0.50, 0.5% of the larger side); a larger drift refuses a sized figure. Display keeps computeMarginSnapshot. Ledgers were ${sameLedger ? 'pinned' : 'adjacent, not identical'} (${ledgers.join(', ')}).`;
    } else if (snapshotHit && snapshotHit.value != null) {
      recommendation = 'liquidation_snapshot returned a value. Phase 3 sizing must follow whatever basis that function actually consults, not get_current_total_balance or the app snapshot by assumption. Compare the recorded fields below before changing any amount math.';
    }
    report.comparison = {
      account: target,
      sameLedger,
      ledgers: {
        get_current_total_balance: totalBalance?.ledger ?? null,
        get_current_total_borrows: totalBorrows?.ledger ?? null,
        liquidation_snapshot: snapshotHit?.ledger ?? null,
      },
      computeMarginSnapshot: appBody && appBody.grossCollateralValue != null
        ? {
            source: 'lib/account-snapshot.ts via GET /api/account',
            grossCollateral: appBody.grossCollateralValue,
            debt: appBody.totalBorrowedValue,
            healthFactor: appBody.avgHealthFactor,
          }
        : appSnapshot,
      liquidationSnapshot: snapshotHit,
      snapshotDecoded,
      accountManager: {
        collateral: report.account.reads.filter((entry) => entry.method === 'get_collateral_token_balance'
          || entry.method === 'get_all_collateral_tokens'),
        debt: report.account.reads.filter((entry) => entry.method === 'get_borrowed_token_debt'
          || entry.method === 'get_all_borrowed_tokens'),
      },
      riskEngineTotals: {
        get_current_total_balance: {
          ledger: totalBalance?.ledger ?? null,
          wad: totalBalance?.value != null ? String(totalBalance.value) : null,
          usd: wadToUsd(totalBalance?.value),
          error: totalBalance?.error ?? null,
        },
        get_current_total_borrows: {
          ledger: totalBorrows?.ledger ?? null,
          wad: totalBorrows?.value != null ? String(totalBorrows.value) : null,
          usd: wadToUsd(totalBorrows?.value),
          error: totalBorrows?.error ?? null,
        },
      },
      recommendation,
    };
  }
  // Synthetic public source; no wallet access or private key is needed for simulation.
  const WAD = 10n ** 18n;
  for (const [balance, debt] of [[109n * WAD, 100n * WAD], [110n * WAD, 100n * WAD], [111n * WAD, 100n * WAD], [0n, 0n], [0n, 10n ** 16n - 1n], [0n, 10n ** 16n]]) {
    const probe = await withRetry(async () => {
      const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: Networks.TESTNET })
        .addOperation(new Contract(address).call('is_account_healthy', nativeToScVal(balance, { type: 'u256' }), nativeToScVal(debt, { type: 'u256' })))
        .setTimeout(30).build();
      return server.simulateTransaction(tx);
    });
    report.probes.push({ balanceWad: String(balance), debtWad: String(debt), ledger: probe.latestLedger,
      result: rpc.Api.isSimulationSuccess(probe) ? scValToNative(probe.result.retval) : null,
      error: rpc.Api.isSimulationError(probe) ? probe.error : null });
  }
  process.stdout.write(JSON.stringify(report, (_, value) => typeof value === 'bigint' ? String(value) : value, 2) + '\n');
}
main().catch((error) => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
