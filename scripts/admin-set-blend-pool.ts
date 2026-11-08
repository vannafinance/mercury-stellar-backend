/**
 * Admin script: Set Blend pool address in Registry contract.
 *
 * This MUST be run by the protocol admin BEFORE any Blend deposit/withdraw
 * transactions can succeed. Without it, SmartAccount.execute() panics with:
 *   "No external protocol mapped for the given protocol address"
 *   → HostError: Error(WasmVm, InvalidAction) / UnreachableCodeReached
 *
 * Usage:
 *   npx ts-node scripts/admin-set-blend-pool.ts <ADMIN_SECRET_KEY> [BLEND_POOL_ADDRESS]
 *
 * The admin wallet is: GAUVY7FNDKVWRMW3SYEMX6QMFSWQDKC6XIPJJKAMOEMLZPAI7XZPDV3D
 */

import * as StellarSdk from '@stellar/stellar-sdk';
import { CONTRACT_ADDRESSES } from '../lib/stellar-utils';

const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

const REGISTRY_ADDRESS = CONTRACT_ADDRESSES.REGISTRY;

async function setBlendPoolAddress(adminSecretKey: string, blendPoolAddress: string) {
  const adminKeypair = StellarSdk.Keypair.fromSecret(adminSecretKey);
  console.log('Admin address:', adminKeypair.publicKey());
  console.log('Blend pool address:', blendPoolAddress);

  const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
  const adminAccount = await server.getAccount(adminKeypair.publicKey());

  const registryContract = new StellarSdk.Contract(REGISTRY_ADDRESS);

  const transaction = new StellarSdk.TransactionBuilder(adminAccount, {
    fee: (parseInt(StellarSdk.BASE_FEE) * 10).toString(),
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      registryContract.call(
        'set_blend_pool_address',
        StellarSdk.nativeToScVal(blendPoolAddress, { type: 'address' })
      )
    )
    .setTimeout(30)
    .build();

  console.log('Preparing transaction...');
  const preparedTx = await server.prepareTransaction(transaction);
  preparedTx.sign(adminKeypair);

  console.log('Submitting transaction...');
  const result = await server.sendTransaction(preparedTx as StellarSdk.Transaction);
  console.log('Transaction submitted:', result.hash);
  console.log('Status:', result.status);

  if (result.status === 'PENDING') {
    // Poll for completion
    let attempts = 0;
    while (attempts < 30) {
      await new Promise((r) => setTimeout(r, 2000));
      const tx = await server.getTransaction(result.hash);
      if (tx.status !== 'NOT_FOUND') {
        if (tx.status === 'SUCCESS') {
          console.log('✓ Success! Blend pool address set in Registry.');
          console.log('  Registry:', REGISTRY_ADDRESS);
          console.log('  Blend pool:', blendPoolAddress);
          return;
        } else {
          console.error('✗ Transaction failed:', tx.status);
          console.error(tx);
          process.exit(1);
        }
      }
      attempts++;
    }
    console.error('Transaction timed out');
    process.exit(1);
  }
}

const adminSecret = process.argv[2];
const blendPoolAddress = process.argv[3] ?? CONTRACT_ADDRESSES.BLEND_POOL;
if (!adminSecret) {
  console.error('Usage: npx ts-node scripts/admin-set-blend-pool.ts <ADMIN_SECRET_KEY> [BLEND_POOL_ADDRESS]');
  process.exit(1);
}

setBlendPoolAddress(adminSecret, blendPoolAddress).catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
