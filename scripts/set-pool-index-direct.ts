import * as StellarSdk from '@stellar/stellar-sdk';
import { CONTRACT_ADDRESSES } from '../lib/stellar-utils';

const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
const REGISTRY = CONTRACT_ADDRESSES.REGISTRY;
const ADMIN_SECRET = 'SCEWN2DJDWOVKBQ6YVGP24ZW6DRUO5WPPMCTSSC5ABHW5OPJ7BWKVUV2';
const CORRECT_POOL_INDEX_HEX = '9ac7a9cde23ac2ada11105eeaa42e43c2ea8332ca0aa8f41f58d7160274d718e';
const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
const adminKp = StellarSdk.Keypair.fromSecret(ADMIN_SECRET);
const registry = new StellarSdk.Contract(REGISTRY);

const main = async () => {
  const poolIndexBuf = Buffer.from(CORRECT_POOL_INDEX_HEX, 'hex');
  const acc = await server.getAccount(adminKp.publicKey());
  const tx = new StellarSdk.TransactionBuilder(acc, {
    fee: (parseInt(StellarSdk.BASE_FEE) * 20).toString(),
    networkPassphrase: NETWORK_PASSPHRASE,
  }).addOperation(
    registry.call('set_aquarius_pool_index', StellarSdk.xdr.ScVal.scvBytes(poolIndexBuf))
  ).setTimeout(30).build();

  const sim = await server.simulateTransaction(tx);
  if (!StellarSdk.rpc.Api.isSimulationSuccess(sim)) {
    console.error('Simulation failed:', (sim as any).error); process.exit(1);
  }
  const preparedTx = await server.prepareTransaction(tx);
  preparedTx.sign(adminKp);
  const result = await server.sendTransaction(preparedTx as StellarSdk.Transaction);
  console.log('✅ set_aquarius_pool_index submitted. Status:', result.status, 'Hash:', result.hash);
};
main().catch(e => { console.error(e); process.exit(1); });
