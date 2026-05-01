import * as StellarSdk from '@stellar/stellar-sdk';
const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
const REAL_ROUTER = 'CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD';
const CIRCLE_USDC = 'CB3TLW74NBIOT3BUWOZ3TUM6RFDF6A4GVIRUQRQZABG5KPOUL4JJOV2F';
const XLM = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);

const simCall = async (id: string, fn: string, args: StellarSdk.xdr.ScVal[] = []) => {
  const kp = StellarSdk.Keypair.random();
  const acc = new StellarSdk.Account(kp.publicKey(), '0');
  const tx = new StellarSdk.TransactionBuilder(acc, { fee: StellarSdk.BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new StellarSdk.Contract(id).call(fn, ...args)).setTimeout(30).build();
  return server.simulateTransaction(tx);
};

const main = async () => {
  console.log('=== Check for Circle USDC / XLM pools ===');
  const vec = StellarSdk.xdr.ScVal.scvVec([CIRCLE_USDC, XLM].map(id => StellarSdk.nativeToScVal(id, { type: 'address' })));
  const sim = await simCall(REAL_ROUTER, 'get_pools', [vec]);
  if (StellarSdk.rpc.Api.isSimulationSuccess(sim)) {
    const retval = sim.result!.retval;
    if (retval.switch().name === 'scvMap') {
      const entries = retval.map()!;
      console.log('Found', entries.length, 'pool(s) for Circle USDC/XLM:');
      for (const e of entries) {
        const val = StellarSdk.scValToNative(e.val());
        const poolAddr = typeof val === 'string' ? val : StellarSdk.StrKey.encodeContract(Buffer.from(val as any));
        const keyXdr = e.key();
        let indexHex = '';
        if (keyXdr.switch().name === 'scvBytes') {
          indexHex = Buffer.from(keyXdr.bytes()).toString('hex');
        }
        console.log('  Pool:', poolAddr, '| Index:', indexHex);
        // Check if pool is alive
        try {
          const info = await server.getContractData(poolAddr, StellarSdk.xdr.ScVal.scvLedgerKeyContractInstance(), StellarSdk.rpc.Durability.Persistent);
          console.log('    TTL:', info.liveUntilLedgerSeq, '✅ alive');
        } catch(e: any) { console.log('    NOT alive:', e.message?.slice(0,80)); }
      }
    } else {
      console.log('No pools / unexpected format:', retval.switch().name);
    }
  } else {
    console.log('get_pools failed:', (sim as any).error?.slice(0,300));
  }
};
main().catch(console.error);
