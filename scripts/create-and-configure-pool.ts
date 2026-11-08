import * as StellarSdk from '@stellar/stellar-sdk';
import { CONTRACT_ADDRESSES } from '../lib/stellar-utils';

const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
const REAL_ROUTER = 'CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD';
const REGISTRY = CONTRACT_ADDRESSES.REGISTRY;
const CIRCLE_USDC = 'CB3TLW74NBIOT3BUWOZ3TUM6RFDF6A4GVIRUQRQZABG5KPOUL4JJOV2F';
const XLM = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const ADMIN_SECRET = 'SCEWN2DJDWOVKBQ6YVGP24ZW6DRUO5WPPMCTSSC5ABHW5OPJ7BWKVUV2';
const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
const adminKp = StellarSdk.Keypair.fromSecret(ADMIN_SECRET);

const sendTx = async (op: StellarSdk.xdr.Operation, label: string) => {
  const acc = await server.getAccount(adminKp.publicKey());
  const tx = new StellarSdk.TransactionBuilder(acc, {
    fee: (parseInt(StellarSdk.BASE_FEE) * 50).toString(),
    networkPassphrase: NETWORK_PASSPHRASE,
  }).addOperation(op).setTimeout(60).build();
  const sim = await server.simulateTransaction(tx);
  if (!StellarSdk.rpc.Api.isSimulationSuccess(sim)) {
    console.log(`❌ Simulation failed for [${label}]:`, (sim as any).error?.slice(0, 500));
    return null;
  }
  const preparedTx = await server.prepareTransaction(tx);
  preparedTx.sign(adminKp);
  const result = await server.sendTransaction(preparedTx as StellarSdk.Transaction);
  console.log(`✅ ${label}: hash=${result.hash}, status=${result.status}`);
  return result;
};

const waitTx = async (hash: string) => {
  for (let i = 0; i < 20; i++) {
    const result = await server.getTransaction(hash);
    if (result.status === 'SUCCESS') return result;
    if (result.status === 'FAILED') throw new Error('tx failed: ' + JSON.stringify((result as any).resultXdr));
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('timeout waiting for tx');
};

const main = async () => {
  const router = new StellarSdk.Contract(REAL_ROUTER);
  const registry = new StellarSdk.Contract(REGISTRY);

  // Step 1: Create Circle USDC / XLM pool via init_standard_pool
  console.log('=== Step 1: Create Circle USDC/XLM pool ===');
  const tokensVec = StellarSdk.xdr.ScVal.scvVec([
    StellarSdk.nativeToScVal(CIRCLE_USDC, { type: 'address' }),
    StellarSdk.nativeToScVal(XLM, { type: 'address' }),
  ]);
  
  const createOp = router.call(
    'init_standard_pool',
    StellarSdk.nativeToScVal(adminKp.publicKey(), { type: 'address' }),
    tokensVec,
    StellarSdk.xdr.ScVal.scvU32(30),
  );

  // First simulate to get pool info
  const acc = await server.getAccount(adminKp.publicKey());
  const simTx = new StellarSdk.TransactionBuilder(acc, {
    fee: (parseInt(StellarSdk.BASE_FEE) * 50).toString(),
    networkPassphrase: NETWORK_PASSPHRASE,
  }).addOperation(createOp).setTimeout(60).build();
  
  const simResult = await server.simulateTransaction(simTx);
  if (!StellarSdk.rpc.Api.isSimulationSuccess(simResult)) {
    console.log('❌ init_standard_pool simulation failed:', (simResult as any).error?.slice(0, 800));
    return;
  }
  
  const retval = StellarSdk.scValToNative(simResult.result!.retval);
  console.log('init_standard_pool result:', retval);
  
  // Extract pool index and address
  let poolIndex: Buffer | null = null;
  let poolAddress = '';
  if (Array.isArray(retval) && retval.length === 2) {
    const indexRaw = retval[0];
    const addrRaw = retval[1];
    poolIndex = Buffer.isBuffer(indexRaw) ? indexRaw : Buffer.from(indexRaw as Uint8Array);
    poolAddress = typeof addrRaw === 'string' ? addrRaw : StellarSdk.StrKey.encodeContract(Buffer.from(addrRaw as any));
    console.log('Pool index:', poolIndex.toString('hex'));
    console.log('Pool address:', poolAddress);
  }

  if (!poolIndex) { console.log('❌ Could not extract pool index'); return; }

  // Send the transaction
  const createResult = await sendTx(createOp, 'Create Circle USDC/XLM pool');
  if (!createResult) return;
  if (createResult.status === 'PENDING') {
    try { await waitTx(createResult.hash); console.log('✅ Pool created!'); } catch(e: any) { console.log('Wait error:', e.message); }
  }

  // Step 2: Update Registry router address
  console.log('\n=== Step 2: Set correct router in Registry ===');
  await sendTx(
    registry.call('set_aquarius_router_address', StellarSdk.nativeToScVal(REAL_ROUTER, { type: 'address' })),
    'Set router'
  );

  // Step 3: Update Registry pool index  
  console.log('\n=== Step 3: Set pool index in Registry ===');
  await sendTx(
    registry.call('set_aquarius_pool_index', StellarSdk.xdr.ScVal.scvBytes(poolIndex)),
    'Set pool index'
  );
  
  console.log('\n=== Summary ===');
  console.log('New pool address:', poolAddress);
  console.log('Pool index hex:', poolIndex.toString('hex'));
  console.log('Router:', REAL_ROUTER);
  console.log('\nUpdate stellar-utils.ts:');
  console.log(`AQUARIUS_XLM_USDC_POOL: '${poolAddress}'`);
  console.log(`AQUARIUS_ROUTER: '${REAL_ROUTER}'`);
};
main().catch(console.error);
