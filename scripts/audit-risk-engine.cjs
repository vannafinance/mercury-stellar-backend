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
  const resolved = await server.simulateTransaction(lookup);
  if (!rpc.Api.isSimulationSuccess(resolved)) throw new Error(`Registry resolution failed: ${resolved.error ?? 'no result'}`);
  const address = scValToNative(resolved.result.retval);
  const instance = await server.getContractData(address, xdr.ScVal.scvLedgerKeyContractInstance());
  const hash = instance.val.contractData().val().instance().executable().wasmHash().toString('hex');
  const report = { network: 'testnet', registry, contract: address, wasmHash: hash, resolutionLedger: resolved.latestLedger, checkedAt: new Date().toISOString(), probes: [] };
  const target = process.argv[2];
  if (target && !StrKey.isValidContract(target)) throw new Error('Expected a valid public smart-account address');
  async function read(contract, method, args = []) {
    const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: Networks.TESTNET })
      .addOperation(new Contract(contract).call(method, ...args)).setTimeout(30).build();
    const result = await server.simulateTransaction(tx);
    return { method, ledger: result.latestLedger,
      value: rpc.Api.isSimulationSuccess(result) ? scValToNative(result.result.retval) : null,
      error: rpc.Api.isSimulationError(result) ? result.error : null };
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
  }
  // Synthetic public source; no wallet access or private key is needed for simulation.
  const WAD = 10n ** 18n;
  for (const [balance, debt] of [[109n * WAD, 100n * WAD], [110n * WAD, 100n * WAD], [111n * WAD, 100n * WAD], [0n, 0n], [0n, 10n ** 16n - 1n], [0n, 10n ** 16n]]) {
    const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: Networks.TESTNET })
      .addOperation(new Contract(address).call('is_account_healthy', nativeToScVal(balance, { type: 'u256' }), nativeToScVal(debt, { type: 'u256' })))
      .setTimeout(30).build();
    const result = await server.simulateTransaction(tx);
    report.probes.push({ balanceWad: String(balance), debtWad: String(debt), ledger: result.latestLedger,
      result: rpc.Api.isSimulationSuccess(result) ? scValToNative(result.result.retval) : null,
      error: rpc.Api.isSimulationError(result) ? result.error : null });
  }
  process.stdout.write(JSON.stringify(report, (_, value) => typeof value === 'bigint' ? String(value) : value, 2) + '\n');
}
main().catch((error) => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
