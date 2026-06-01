// Read the on-chain Reflector oracle price the same way the app does
// (lib/oracle-price.ts): simulate get_price_latest(<symbol>) and decode
// [rawPrice, decimals] -> rawPrice / 10^decimals.
//
// Usage:  node scripts/check-oracle-price.mjs [SYMBOL ...]
//   node scripts/check-oracle-price.mjs            # defaults to XLM
//   node scripts/check-oracle-price.mjs XLM USDC

import * as StellarSdk from '@stellar/stellar-sdk';

const RPC = 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
const ORACLE = 'CB72D6SOUHUTCESXYOQOBMP6MRSH47NBYIBH73BBRH3ZRT53LPTB6R7V';
// Any funded testnet account works as the simulation source (read-only).
const SOURCE = 'GAUVY7FNDKVWRMW3SYEMX6QMFSWQDKC6XIPJJKAMOEMLZPAI7XZPDV3D';

const symbols = process.argv.slice(2).length ? process.argv.slice(2) : ['XLM'];

async function getPrice(server, source, symbol) {
  const contract = new StellarSdk.Contract(ORACLE);
  const tx = new StellarSdk.TransactionBuilder(source, {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call('get_price_latest', StellarSdk.nativeToScVal(symbol, { type: 'symbol' })))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (!('result' in sim) || !sim.result?.retval) {
    throw new Error(`no result (${sim.error ?? 'unknown'})`);
  }
  const native = StellarSdk.scValToNative(sim.result.retval); // [rawPrice, decimals]
  const raw = native[0];
  const decimals = Number(native[1] ?? 14);
  const price = Number(typeof raw === 'bigint' ? raw.toString() : String(raw)) / Math.pow(10, decimals);
  return { price, raw: String(raw), decimals };
}

const server = new StellarSdk.rpc.Server(RPC);
const source = await server.getAccount(SOURCE);

for (const sym of symbols) {
  try {
    const { price, raw, decimals } = await getPrice(server, source, sym.toUpperCase());
    console.log(`${sym.toUpperCase().padEnd(8)} $${price.toFixed(7)}   (raw=${raw}, decimals=${decimals})`);
  } catch (e) {
    console.log(`${sym.toUpperCase().padEnd(8)} ERROR: ${e.message}`);
  }
}
