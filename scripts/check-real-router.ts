import * as StellarSdk from '@stellar/stellar-sdk';
const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
const REAL_ROUTER = 'CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD';
const CAZRY5 = 'CAZRY5GSFBFXD7H6GAFBA5YGYQTDXU4QKWKMYFWBAZFUCURN3WKX6LF5';
const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);

const simCall = async (id: string, fn: string, args: StellarSdk.xdr.ScVal[] = []) => {
  const kp = StellarSdk.Keypair.random();
  const acc = new StellarSdk.Account(kp.publicKey(), '0');
  const tx = new StellarSdk.TransactionBuilder(acc, { fee: StellarSdk.BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new StellarSdk.Contract(id).call(fn, ...args)).setTimeout(30).build();
  return server.simulateTransaction(tx);
};

const main = async () => {
  // Check real router
  console.log('=== Real Router ===');
  try {
    const info = await server.getContractData(REAL_ROUTER, StellarSdk.xdr.ScVal.scvLedgerKeyContractInstance(), StellarSdk.rpc.Durability.Persistent);
    console.log('EXISTS! TTL:', info.liveUntilLedgerSeq);
    const storage = info.val?.contractData()?.val()?.instance()?.storage() ?? [];
    for (const e of storage.slice(0, 10)) {
      try { const k = StellarSdk.scValToNative(e.key()); const v = StellarSdk.scValToNative(e.val()); console.log(' ', JSON.stringify(k), ':', JSON.stringify(v)?.slice(0,100)); } catch {}
    }
  } catch (e: any) { console.log('ERROR:', e.message?.slice(0, 150)); }

  // Try calling get_pools on real router
  console.log('\n=== Real Router get_pools ===');
  const xlmId = StellarSdk.Asset.native().contractId(NETWORK_PASSPHRASE);
  const usdc1 = new StellarSdk.Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5').contractId(NETWORK_PASSPHRASE);
  console.log('XLM:', xlmId, '| USDC(circle):', usdc1, '| TokenA:', CAZRY5);
  try {
    const vec = StellarSdk.xdr.ScVal.scvVec([CAZRY5, xlmId].map(id => StellarSdk.nativeToScVal(id, { type: 'address' })));
    const sim = await simCall(REAL_ROUTER, 'get_pools', [vec]);
    if (StellarSdk.rpc.Api.isSimulationSuccess(sim)) {
      const native: any = StellarSdk.scValToNative(sim.result!.retval);
      console.log('type:', typeof native, native instanceof Map ? 'Map' : '');
      if (native instanceof Map) {
        for (const [k, v] of native.entries()) {
          const pool = typeof v === 'string' ? v : StellarSdk.StrKey.encodeContract(Buffer.from(v));
          const idx = Buffer.isBuffer(k) ? k.toString('hex') : k instanceof Uint8Array ? Buffer.from(k).toString('hex') : String(k);
          const match = pool === 'CD3LFMMLBQ6RBJUD3Z2LFDFE6544WDRMWHEZYPI5YDVESYRSO2TT32BX' ? ' ✅ MATCH' : '';
          console.log(' pool:', pool, '| index:', idx.slice(0,16)+'...', match);
        }
      } else { console.log('result:', JSON.stringify(native)?.slice(0,300)); }
    } else { console.log('failed:', (sim as any).error?.slice(0, 300)); }
  } catch (e: any) { console.log('error:', e.message?.slice(0, 300)); }

  // Check CAZRY5 symbol/name
  console.log('\n=== CAZRY5 token info ===');
  for (const fn of ['symbol', 'name', 'decimals']) {
    try {
      const sim = await simCall(CAZRY5, fn);
      if (StellarSdk.rpc.Api.isSimulationSuccess(sim)) { console.log(fn+':', StellarSdk.scValToNative(sim.result!.retval)); }
    } catch (e: any) { console.log(fn+':', e.message?.slice(0,100)); }
  }
};
main().catch(console.error);
