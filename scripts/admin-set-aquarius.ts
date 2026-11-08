/**
 * Admin script: Set Aquarius router address + pool index in Registry contract.
 *
 * Usage:
 *   npx ts-node scripts/admin-set-aquarius.ts <KEY> [ROUTER_CONTRACT_ID] [POOL_CONTRACT_ID] [TOKEN_B_CODE] [TOKEN_B_ISSUER] [FEE_FRACTION]
 *
 * <KEY> can be either:
 *   - A raw Stellar secret key (starts with 'S')
 *   - A Stellar CLI account name (e.g. "vanna_deployer") — reads from ~/.config/stellar/identity/<name>.toml
 *
 * Notes:
 * - Pool index is derived by calling Aquarius router get_pools(tokens) and
 *   matching the pool contract ID.
 * - Uses Testnet assets: XLM + TOKEN_B (defaults to Aquarius USDC issuer).
 * - Also updates Registry Aquarius USDC mapping + Aquarius USDC lending pool.
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
  ASSET_ISSUERS,
} from '../lib/stellar-utils';

/**
 * Resolve a Stellar CLI account name or raw secret key to a Keypair.
 * If `nameOrSecret` starts with 'S' and is 56 chars it's treated as a raw secret key.
 * Otherwise it's treated as a Stellar CLI identity name and the seed phrase is read
 * from ~/.config/stellar/identity/<name>.toml, then derived via BIP44 m/44'/148'/0'.
 */
function resolveKeypair(nameOrSecret: string): StellarSdk.Keypair {
  // Raw secret key
  if (/^S[A-Z2-7]{55}$/.test(nameOrSecret)) {
    return StellarSdk.Keypair.fromSecret(nameOrSecret);
  }

  // Stellar CLI identity name — read the .toml file
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

  // Parse seed_phrase field (simple regex — avoids TOML dependency)
  const seedMatch = tomlContent.match(/seed_phrase\s*=\s*"([^"]+)"/);
  const secretMatch = tomlContent.match(/secret_key\s*=\s*"([^"]+)"/);

  if (secretMatch) {
    return StellarSdk.Keypair.fromSecret(secretMatch[1]);
  }

  if (seedMatch) {
    const mnemonic = seedMatch[1];
    const seed = mnemonicToSeedSync(mnemonic);
    const { key } = derivePath("m/44'/148'/0'", seed.toString('hex'));
    return StellarSdk.Keypair.fromRawEd25519Seed(Buffer.from(key));
  }

  throw new Error(
    `Could not find "seed_phrase" or "secret_key" in ${identityPath}`
  );
}

const DEFAULT_ROUTER = CONTRACT_ADDRESSES.AQUARIUS_ROUTER;
const DEFAULT_TOKEN_B_CODE = 'USDC';
const DEFAULT_TOKEN_B_ISSUER = ASSET_ISSUERS.USDC_AQUARIUS;
const DEFAULT_FEE_FRACTION = 30;

const toContractId = (asset: StellarSdk.Asset) =>
  asset.contractId(NETWORK_PASSPHRASE);

const orderTokenIds = (ids: string[]) => {
  const toHex = (id: string) =>
    Buffer.from(StellarSdk.StrKey.decodeContract(id)).toString('hex');
  return [...ids].sort((a, b) => {
    const ah = toHex(a);
    const bh = toHex(b);
    if (ah < bh) return -1;
    if (ah > bh) return 1;
    return 0;
  });
};

const getPoolIndexFromRouter = async (
  routerId: string,
  tokenIds: string[],
  targetPoolId: string
): Promise<Buffer> => {
  const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
  const tempKeypair = StellarSdk.Keypair.random();
  const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');
  const contract = new StellarSdk.Contract(routerId);

  const ordered = orderTokenIds(tokenIds);
  const tokensVec = StellarSdk.xdr.ScVal.scvVec(
    ordered.map((id) => StellarSdk.nativeToScVal(id, { type: 'address' }))
  );

  const tx = new StellarSdk.TransactionBuilder(tempAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call('get_pools', tokensVec))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
    throw new Error('Failed to simulate get_pools');
  }

  const mapVal: any = StellarSdk.scValToNative(sim.result.retval);
  if (!mapVal) {
    throw new Error('get_pools returned empty map');
  }

  const normalizeId = (id: any) => {
    if (typeof id === 'string') return id;
    if (id?.toString) return id.toString();
    return String(id);
  };

  const matchPool = normalizeId(targetPoolId);

  // Map can be JS Map or plain object depending on SDK version
  if (mapVal instanceof Map) {
    for (const [key, val] of mapVal.entries()) {
      const poolId = normalizeId(val);
      if (poolId === matchPool) {
        const keyBuf = Buffer.isBuffer(key)
          ? key
          : Buffer.from(key as Uint8Array);
        if (keyBuf.length !== 32) {
          throw new Error('Pool index is not 32 bytes');
        }
        return keyBuf;
      }
    }
  } else {
    // Fallback: object where keys are hex
    for (const [hexKey, val] of Object.entries(mapVal)) {
      const poolId = normalizeId(val);
      if (poolId === matchPool) {
        const keyBuf = Buffer.from(hexKey.replace(/^0x/, ''), 'hex');
        if (keyBuf.length !== 32) {
          throw new Error('Pool index is not 32 bytes');
        }
        return keyBuf;
      }
    }
  }

  throw new Error('Pool index not found for target pool');
};

const xdrString = (value: string): Buffer => {
  const strBuf = Buffer.from(value, 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(strBuf.length, 0);
  const padLen = (4 - (strBuf.length % 4)) % 4;
  const pad = Buffer.alloc(padLen, 0);
  return Buffer.concat([lenBuf, strBuf, pad]);
};

const xdrU32 = (value: number): Buffer => {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value >>> 0, 0);
  return buf;
};

const computeStandardPoolIndex = (feeFraction: number): Buffer => {
  // Mirrors get_standard_pool_salt in router:
  // sha256( Symbol("standard") || Symbol("0x00") || u32(fee) || Symbol("0x00") )
  const preimage = Buffer.concat([
    xdrString('standard'),
    xdrString('0x00'),
    xdrU32(feeFraction),
    xdrString('0x00'),
  ]);
  const hash = StellarSdk.hash(preimage);
  return Buffer.from(hash);
};

const main = async () => {
  const keyArg = process.argv[2];
  const routerId = process.argv[3] || DEFAULT_ROUTER;
  const poolId = process.argv[4] || CONTRACT_ADDRESSES.AQUARIUS_XLM_USDC_POOL;
  const tokenBCode = process.argv[5] || DEFAULT_TOKEN_B_CODE;
  const tokenBIssuer = process.argv[6] || DEFAULT_TOKEN_B_ISSUER;
  const feeFraction = parseInt(process.argv[7] || String(DEFAULT_FEE_FRACTION), 10);

  if (!keyArg) {
    console.error('Usage: npx ts-node scripts/admin-set-aquarius.ts <KEY> [ROUTER_CONTRACT_ID] [POOL_CONTRACT_ID] [TOKEN_B_CODE] [TOKEN_B_ISSUER] [FEE_FRACTION]');
    console.error('  <KEY> = raw secret key (S...) OR Stellar CLI account name (e.g. "vanna_deployer")');
    process.exit(1);
  }

  if (!routerId || !poolId || !tokenBCode || !tokenBIssuer || Number.isNaN(feeFraction)) {
    throw new Error('Router, pool contract ID, token issuer, or fee missing');
  }

  const adminKeypair = resolveKeypair(keyArg);
  console.log('Admin public key:', adminKeypair.publicKey());
  const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
  const registry = new StellarSdk.Contract(CONTRACT_ADDRESSES.REGISTRY);

  // Build token contract IDs (XLM + TOKEN_B)
  const xlmAsset = StellarSdk.Asset.native();
  const tokenBAsset = new StellarSdk.Asset(tokenBCode, tokenBIssuer);
  const tokenBContractId = toContractId(tokenBAsset);
  const tokenIds = [toContractId(xlmAsset), toContractId(tokenBAsset)];

  console.log('Router:', routerId);
  console.log('Target pool:', poolId);
  console.log('Token B:', tokenBCode, tokenBIssuer);
  console.log('Token IDs:', tokenIds.join(', '));

  let poolIndex: Buffer | null = null;
  try {
    poolIndex = await getPoolIndexFromRouter(routerId, tokenIds, poolId);
    console.log('Pool index (from router, hex):', poolIndex.toString('hex'));
  } catch (err) {
    if (
      CONTRACT_ADDRESSES.AQUARIUS_POOL_INDEX_HEX &&
      CONTRACT_ADDRESSES.AQUARIUS_POOL_INDEX_HEX.length === 64
    ) {
      console.warn('Router lookup failed, using configured AQUARIUS_POOL_INDEX_HEX fallback...');
      poolIndex = Buffer.from(CONTRACT_ADDRESSES.AQUARIUS_POOL_INDEX_HEX, 'hex');
      console.log('Pool index (configured fallback, hex):', poolIndex.toString('hex'));
    } else {
      console.warn('Router lookup failed, computing pool index from fee_fraction...');
      poolIndex = computeStandardPoolIndex(feeFraction);
      console.log('Pool index (computed, hex):', poolIndex.toString('hex'));
    }
  }

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
      console.error(`Simulation failed for ${label}:`, sim);
      process.exit(1);
    }

    const preparedTx = await server.prepareTransaction(tx);
    preparedTx.sign(adminKeypair);
    const result = await server.sendTransaction(preparedTx as StellarSdk.Transaction);
    if (result.status === 'PENDING') {
      console.log(`✓ ${label} submitted. Tx hash:`, result.hash);
      return;
    }
    console.error(`Transaction rejected for ${label}:`, result);
    process.exit(1);
  };

  await sendSingleOp(
    registry.call(
      'set_aquarius_router_address',
      StellarSdk.nativeToScVal(routerId, { type: 'address' })
    ),
    'Set Aquarius router address'
  );

  await sendSingleOp(
    registry.call('set_aquarius_pool_index', StellarSdk.xdr.ScVal.scvBytes(poolIndex)),
    'Set Aquarius pool index'
  );

  await sendSingleOp(
    registry.call(
      'set_aquarius_usdc_addr',
      StellarSdk.nativeToScVal(tokenBContractId, { type: 'address' })
    ),
    'Set Registry Aquarius USDC contract address'
  );

  console.log('✓ Registry Aquarius USDC token set to:', tokenBContractId);
  console.log('✓ Registry Aquarius USDC lending pool is configured via frontend constants:', CONTRACT_ADDRESSES.LENDING_PROTOCOL_AQUARIUS_USDC);
};

main().catch((err) => {
  console.error('Failed to set Aquarius router/pool index:', err);
  process.exit(1);
});
