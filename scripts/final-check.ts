import * as StellarSdk from '@stellar/stellar-sdk';
import { CONTRACT_ADDRESSES } from '../lib/stellar-utils';

const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
const REAL_ROUTER = 'CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD';
const TARGET_POOL = 'CD3LFMMLBQ6RBJUD3Z2LFDFE6544WDRMWHEZYPI5YDVESYRSO2TT32BX';
const CAZRY5 = 'CAZRY5GSFBFXD7H6GAFBA5YGYQTDXU4QKWKMYFWBAZFUCURN3WKX6LF5';
const XLM_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const REGISTRY = CONTRACT_ADDRESSES.REGISTRY;
const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);

const simCall = async (id: string, fn: string, args: StellarSdk.xdr.ScVal[] = []) => {
  const kp = StellarSdk.Keypair.random();
  const acc = new StellarSdk.Account(kp.publicKey(), '0');
  const tx = new StellarSdk.TransactionBuilder(acc, { fee: StellarSdk.BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new StellarSdk.Contract(id).call(fn, ...args)).setTimeout(30).build();
  return server.simulateTransaction(tx);
};

const main = async () => {
  // 1. Find the correct pool index from real router
  console.log('=== Pool index from real router ===');
  const vec = StellarSdk.xdr.ScVal.scvVec([CAZRY5, XLM_CONTRACT].map(id => StellarSdk.nativeToScVal(id, { type: 'address' })));
  const sim = await simCall(REAL_ROUTER, 'get_pools', [vec]);
  let poolIndexHex = '';
  if (StellarSdk.rpc.Api.isSimulationSuccess(sim)) {
    const retval = sim.result!.retval;
    // Parse the raw scval map to get binary keys
    if (retval.switch().name === 'scvMap') {
      const entries = retval.map()!;
      for (const e of entries) {
        const val = StellarSdk.scValToNative(e.val());
        const poolAddr = typeof val === 'string' ? val : StellarSdk.StrKey.encodeContract(Buffer.from(val as any));
        if (poolAddr === TARGET_POOL) {
          const keyXdr = e.key();
          if (keyXdr.switch().name === 'scvBytes') {
            poolIndexHex = Buffer.from(keyXdr.bytes()).toString('hex');
          } else {
            const keyNative = StellarSdk.scValToNative(keyXdr);
            poolIndexHex = Buffer.isBuffer(keyNative) ? keyNative.toString('hex') : Buffer.from(keyNative as any).toString('hex');
          }
          console.log('✅ Pool index for CD3LF...:', poolIndexHex);
        }
      }
    }
  } else { console.log('failed:', (sim as any).error?.slice(0,200)); }

  // 2. Check Blend pool USDC asset
  console.log('\n=== Blend pool USDC check ===');
  const blendSim = await simCall(REGISTRY, 'get_usdc_contract_address');
  if (StellarSdk.rpc.Api.isSimulationSuccess(blendSim)) {
    const usdcAddr = StellarSdk.scValToNative(blendSim.result!.retval);
    console.log('Registry USDC:', usdcAddr);
    console.log('Aquarius USDC:', CAZRY5);
    console.log('Match:', usdcAddr === CAZRY5 ? '✅ SAME' : '❌ DIFFERENT — must update Registry');
  }

  // 3. Check CAZRY5 Aquarius USDC from issuer
  const aquariusIssuer = 'GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER';
  const computedAquariusUsdc = new StellarSdk.Asset('USDC', aquariusIssuer).contractId(NETWORK_PASSPHRASE);
  console.log('\nComputed Aquarius USDC contract:', computedAquariusUsdc);
  console.log('Matches CAZRY5:', computedAquariusUsdc === CAZRY5 ? '✅' : '❌');
  console.log('\nPool index hex to set in Registry:', poolIndexHex);
  console.log('Router to set in Registry:', REAL_ROUTER);
  console.log('USDC to set in Registry:', CAZRY5);
};
main().catch(console.error);
