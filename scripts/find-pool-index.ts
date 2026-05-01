import * as StellarSdk from '@stellar/stellar-sdk';

const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
const AQUARIUS_ROUTER = 'CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK';
const TARGET_POOL = 'CD3LFMMLBQ6RBJUD3Z2LFDFE6544WDRMWHEZYPI5YDVESYRSO2TT32BX';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const main = async () => {
  const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
  const tempKp = StellarSdk.Keypair.random();
  const tempAcc = new StellarSdk.Account(tempKp.publicKey(), '0');
  const router = new StellarSdk.Contract(AQUARIUS_ROUTER);

  const xlmId = StellarSdk.Asset.native().contractId(NETWORK_PASSPHRASE);
  const usdcId = new StellarSdk.Asset('USDC', USDC_ISSUER).contractId(NETWORK_PASSPHRASE);
  console.log('XLM contract:', xlmId);
  console.log('USDC contract:', usdcId);

  for (const [label, ids] of [['XLM,USDC', [xlmId, usdcId]], ['USDC,XLM', [usdcId, xlmId]]] as const) {
    try {
      const vec = StellarSdk.xdr.ScVal.scvVec(
        ids.map((id) => StellarSdk.nativeToScVal(id, { type: 'address' }))
      );
      const tx = new StellarSdk.TransactionBuilder(tempAcc, {
        fee: StellarSdk.BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE
      }).addOperation(router.call('get_pools', vec)).setTimeout(30).build();
      const sim = await server.simulateTransaction(tx);
      if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
        console.log(`[${label}] failed:`, (sim as any).error ?? 'no result');
        continue;
      }
      const native: any = StellarSdk.scValToNative(sim.result.retval);
      console.log(`\n[${label}] type:`, typeof native, native instanceof Map ? '(Map)' : '');

      const printPool = (k: any, v: any) => {
        const pool = typeof v === 'string' ? v
          : Buffer.isBuffer(v) ? StellarSdk.StrKey.encodeContract(v)
          : v instanceof Uint8Array ? StellarSdk.StrKey.encodeContract(Buffer.from(v))
          : String(v);
        const idx = Buffer.isBuffer(k) ? k.toString('hex')
          : k instanceof Uint8Array ? Buffer.from(k).toString('hex')
          : String(k);
        const found = pool === TARGET_POOL ? ' ✅ MATCH!' : '';
        console.log(`  idx: ${idx.slice(0,16)}... | pool: ${pool}${found}`);
        if (found) console.log('  FULL INDEX HEX:', idx);
      };

      if (native instanceof Map) {
        console.log('Map size:', native.size);
        for (const [k, v] of native.entries()) printPool(k, v);
      } else if (native && typeof native === 'object') {
        const entries = Object.entries(native);
        console.log('Object entries:', entries.length);
        for (const [k, v] of entries) printPool(k, v);
      } else {
        console.log('value:', native);
      }
    } catch (e: any) {
      console.log(`[${label}] error:`, e.message);
    }
  }
};

main().catch(console.error);
