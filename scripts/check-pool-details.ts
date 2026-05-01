import * as StellarSdk from '@stellar/stellar-sdk';

const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
const CONFIG_STORAGE = 'CDD3G6M2JSJLXBYLY4N6WLWVU2LB5UGPSKFO5ZV4M6BMYQY555Q6FA46';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);

const main = async () => {
  // Check ConfigStorage contract
  console.log('=== ConfigStorage contract ===');
  try {
    const info = await server.getContractData(
      CONFIG_STORAGE,
      StellarSdk.xdr.ScVal.scvLedgerKeyContractInstance(),
      StellarSdk.rpc.Durability.Persistent
    );
    console.log('EXISTS. TTL:', info.liveUntilLedgerSeq);
    const storage = info.val?.contractData()?.val()?.instance()?.storage();
    if (storage) {
      for (const entry of storage) {
        try {
          const k = StellarSdk.scValToNative(entry.key());
          const v = StellarSdk.scValToNative(entry.val());
          console.log('  key:', JSON.stringify(k), '→ val:', JSON.stringify(v)?.slice(0, 150));
        } catch {}
      }
    }
  } catch (e: any) { console.log('ERROR:', e.message?.slice(0, 200)); }

  // Search for Aquarius router contracts via known token contracts
  console.log('\n=== Searching testnet Aquarius events for pool creation ===');
  try {
    const xlmId = StellarSdk.Asset.native().contractId(NETWORK_PASSPHRASE);
    const usdcId = new StellarSdk.Asset('USDC', USDC_ISSUER).contractId(NETWORK_PASSPHRASE);
    // Check events on pool contract creation
    const result = await server.getEvents({
      startLedger: 4400000,
      filters: [{
        type: 'contract',
        contractIds: ['CD3LFMMLBQ6RBJUD3Z2LFDFE6544WDRMWHEZYPI5YDVESYRSO2TT32BX'],
      }],
      limit: 10,
    });
    console.log('Pool events:', result.events.length);
    for (const ev of result.events.slice(0, 5)) {
      console.log('  tx:', ev.txHash, 'topics:', ev.topic.map(t => { try { return JSON.stringify(StellarSdk.scValToNative(t)); } catch { return '?'; } }));
    }
  } catch (e: any) { console.log('Events error:', e.message?.slice(0, 200)); }
};

main().catch(console.error);
