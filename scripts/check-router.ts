import * as StellarSdk from '@stellar/stellar-sdk';

const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
const AQUARIUS_ROUTER = 'CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK';
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
  // Check router contract instance
  console.log('=== Checking Router contract ===');
  try {
    const info = await server.getContractData(
      AQUARIUS_ROUTER,
      StellarSdk.xdr.ScVal.scvLedgerKeyContractInstance(),
      StellarSdk.rpc.Durability.Persistent
    );
    console.log('Router contract instance EXISTS. TTL:', info.liveUntilLedgerSeq);
  } catch (e: any) {
    console.log('Router contract instance ERROR:', e.message?.slice(0, 200));
  }

  // Check pool contract
  console.log('\n=== Checking Pool contract ===');
  try {
    const info = await server.getContractData(
      POOL,
      StellarSdk.xdr.ScVal.scvLedgerKeyContractInstance(),
      StellarSdk.rpc.Durability.Persistent
    );
    console.log('Pool contract instance EXISTS. TTL:', info.liveUntilLedgerSeq);
    const storage = info.val?.contractData()?.val()?.instance()?.storage();
    if (storage) {
      console.log('Pool storage entries:', storage.length);
      for (const entry of storage.slice(0, 10)) {
        try {
          const k = StellarSdk.scValToNative(entry.key());
          const v = StellarSdk.scValToNative(entry.val());
          console.log('  key:', JSON.stringify(k), '→ val:', JSON.stringify(v)?.slice(0, 100));
        } catch {}
      }
    }
  } catch (e: any) {
    console.log('Pool contract instance ERROR:', e.message?.slice(0, 200));
  }

  // Try calling get_reserves on pool directly
  console.log('\n=== Pool get_reserves ===');
  try {
    const sim = await simCall(POOL, 'get_reserves');
    if (StellarSdk.rpc.Api.isSimulationSuccess(sim)) {
      const val = StellarSdk.scValToNative(sim.result!.retval);
      console.log('get_reserves:', val);
    } else {
      console.log('FAILED:', (sim as any).error?.slice(0, 300));
    }
  } catch (e: any) { console.log('Error:', e.message?.slice(0, 300)); }
};

main().catch(console.error);
