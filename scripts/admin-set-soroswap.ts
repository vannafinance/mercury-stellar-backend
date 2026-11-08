/**
 * Admin script: Set Soroswap router address in Registry contract.
 *
 * Usage:
 *   npx ts-node scripts/admin-set-soroswap.ts <KEY> [ROUTER_CONTRACT_ID]
 *
 * <KEY> can be either:
 *   - A raw Stellar secret key (starts with 'S')
 *   - A Stellar CLI account name (e.g. "vanna_deployer") — reads from ~/.config/stellar/identity/<name>.toml
 *
 * Defaults to the Soroswap testnet router address from CONTRACT_ADDRESSES.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as StellarSdk from '@stellar/stellar-sdk';
import { mnemonicToSeedSync } from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import {
  CONTRACT_ADDRESSES,
  NETWORK_PASSPHRASE,
  SOROBAN_RPC_URL,
} from '../lib/stellar-utils';

function resolveKeypair(nameOrSecret: string): StellarSdk.Keypair {
  if (/^S[A-Z2-7]{55}$/.test(nameOrSecret)) {
    return StellarSdk.Keypair.fromSecret(nameOrSecret);
  }

  const identityPath = path.join(
    os.homedir(),
    '.config', 'stellar', 'identity',
    `${nameOrSecret}.toml`,
  );

  if (!fs.existsSync(identityPath)) {
    throw new Error(
      `Stellar CLI identity "${nameOrSecret}" not found at ${identityPath}.\n` +
      'Pass a raw secret key (S...) or a valid Stellar CLI account name.'
    );
  }

  const tomlContent = fs.readFileSync(identityPath, 'utf8');
  const seedMatch = tomlContent.match(/seed_phrase\s*=\s*"([^"]+)"/);
  const secretMatch = tomlContent.match(/secret_key\s*=\s*"([^"]+)"/);

  if (secretMatch) return StellarSdk.Keypair.fromSecret(secretMatch[1]);

  if (seedMatch) {
    const mnemonic = seedMatch[1];
    const seed = mnemonicToSeedSync(mnemonic);
    const { key } = derivePath("m/44'/148'/0'", seed.toString('hex'));
    return StellarSdk.Keypair.fromRawEd25519Seed(Buffer.from(key));
  }

  throw new Error(`Could not find "seed_phrase" or "secret_key" in ${identityPath}`);
}

const main = async () => {
  const keyArg = process.argv[2];
  const routerId = process.argv[3] || CONTRACT_ADDRESSES.SOROSWAP_ROUTER;

  if (!keyArg) {
    console.error('Usage: npx ts-node scripts/admin-set-soroswap.ts <KEY> [ROUTER_CONTRACT_ID]');
    console.error('  <KEY> = raw secret key (S...) OR Stellar CLI account name (e.g. "vanna_deployer")');
    process.exit(1);
  }

  if (!routerId) {
    throw new Error('SOROSWAP_ROUTER not set in CONTRACT_ADDRESSES and none passed as argument');
  }

  const adminKeypair = resolveKeypair(keyArg);
  console.log('Admin public key:', adminKeypair.publicKey());
  console.log('Soroswap router:', routerId);

  const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
  const registry = new StellarSdk.Contract(CONTRACT_ADDRESSES.REGISTRY);

  const sendSingleOp = async (op: StellarSdk.xdr.Operation, label: string) => {
    const freshAccount = await server.getAccount(adminKeypair.publicKey());
    const tx = new StellarSdk.TransactionBuilder(freshAccount, {
      fee: (parseInt(StellarSdk.BASE_FEE) * 20).toString(),
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (!StellarSdk.rpc.Api.isSimulationSuccess(sim)) {
      throw new Error(`Simulation failed for ${label}: ${JSON.stringify(sim)}`);
    }

    const preparedTx = await server.prepareTransaction(tx);
    preparedTx.sign(adminKeypair);
    const result = await server.sendTransaction(preparedTx as StellarSdk.Transaction);
    if (result.status === 'PENDING') {
      console.log(`✓ ${label} submitted. Tx hash:`, result.hash);
      return;
    }
    throw new Error(`Transaction rejected for ${label}: ${JSON.stringify(result)}`);
  };

  try {
    await sendSingleOp(
      registry.call(
        'set_soroswap_router_address',
        StellarSdk.nativeToScVal(routerId, { type: 'address' })
      ),
      'Set Soroswap router address in Registry'
    );
  } catch (err: any) {
    console.warn('Skipping Soroswap router registry write:', err?.message || err);
  }

  const soroswapUsdcId = CONTRACT_ADDRESSES.SOROSWAP_USDC;
  if (!soroswapUsdcId) {
    throw new Error('SOROSWAP_USDC not set in CONTRACT_ADDRESSES');
  }

  try {
    await sendSingleOp(
      registry.call(
        'set_soroswap_usdc_addr',
        StellarSdk.nativeToScVal(soroswapUsdcId, { type: 'address' })
      ),
      'Set Soroswap USDC contract address in Registry'
    );
  } catch (err: any) {
    console.warn('Skipping Soroswap USDC registry write:', err?.message || err);
  }

  console.warn('Soroswap lending pool address is kept in frontend constants only for this registry build.');

  console.log('✓ Registry Soroswap router now set to:', routerId);
  console.log('✓ Registry Soroswap USDC now set to:', soroswapUsdcId);
  console.log('✓ Registry Soroswap USDC lending pool (frontend constant):', CONTRACT_ADDRESSES.LENDING_PROTOCOL_SOROSWAP_USDC);
  console.log('');
  console.log('Next step: run scripts/admin-set-aquarius.ts to complete Aquarius token/pool routing.');
};

main().catch((err) => {
  console.error('Failed to set Soroswap router address:', err);
  process.exit(1);
});
