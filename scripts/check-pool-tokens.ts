import * as StellarSdk from '@stellar/stellar-sdk';

const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
const POOL = 'CD3LFMMLBQ6RBJUD3Z2LFDFE6544WDRMWHEZYPI5YDVESYRSO2TT32BX';
const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);

const simCall = async (contractId: string, method: string, args: StellarSdk.xdr.ScVal[] = []) => {
  const kp = StellarSdk.Keypair.random();
  const acc = new StellarSdk.Account(kp.publicKey(), '0');
  const contract = new StellarSdk.Contract(contractId);
  const tx = new StellarSdk.TransactionBuilder(acc, {
    fee: StellarSdk.BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE
  }).addOperation(contract.call(method, ...args)).setTimeout(30).build();
  return server.simulateTransaction(tx);
};

const main = async () => {
  // Get all pool storage entries
  const info = await server.getContractData(
    POOL,
    StellarSdk.xdr.ScVal.scvLedgerKeyContractInstance(),
    StellarSdk.rpc.Durability.Persistent
  );
  const storage = info.val?.contractData()?.val()?.instance()?.storage() ?? [];
  console.log('All pool storage entries:');
  for (const entry of storage) {
    try {
      const k = StellarSdk.scValToNative(entry.key());
      const v = StellarSdk.scValToNative(entry.val());
      const vStr = JSON.stringify(v);
      console.log(`  ${JSON.stringify(k)}: ${vStr?.slice(0, 200)}`);
    } catch(e) { console.log('  [parse error]'); }
  }

  // Try calling get_tokens directly
  console.log('\n=== get_tokens ===');
  try {
    const sim = await simCall(POOL, 'get_tokens');
    if (StellarSdk.rpc.Api.isSimulationSuccess(sim)) {
      const val = StellarSdk.scValToNative(sim.result!.retval);
      console.log('tokens:', val);
    } else {
      console.log('failed:', (sim as any).error?.slice(0, 200));
    }
  } catch(e: any) { console.log('error:', e.message?.slice(0, 200)); }

  // Try get_total_shares  
  console.log('\n=== get_total_shares ===');
  try {
    const sim = await simCall(POOL, 'get_total_shares');
    if (StellarSdk.rpc.Api.isSimulationSuccess(sim)) {
      const val = StellarSdk.scValToNative(sim.result!.retval);
      console.log('total_shares:', val);
    } else {
      console.log('failed:', (sim as any).error?.slice(0, 200));
    }
  } catch(e: any) { console.log('error:', e.message?.slice(0, 200)); }

  // Decode what issuer CAZRY5... comes from
  const USDC_ISSUER1 = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
  const c1 = new StellarSdk.Asset('USDC', USDC_ISSUER1).contractId(NETWORK_PASSPHRASE);
  console.log('\nCircle USDC (GBBD47...) contract ID:', c1);
  
  // Also print pool address bytes for storing in Registry
  const poolBytes = StellarSdk.StrKey.decodeContract(POOL);
  console.log('\nPool address as hex (for Registry pool_index):', Buffer.from(poolBytes).toString('hex'));
};

main().catch(console.error);
