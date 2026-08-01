/**
 * Cached Registry.get_protocol_config() helper for mainnet Protocol_V1_Soroban.
 *
 * Standalone getters (get_blend_pool_address, get_aquarius_router_address, etc.)
 * were removed — everything lives on ProtocolConfig. When REGISTRY is empty or
 * the sim fails (Vanna contracts not deployed yet), fall back to CONTRACT_ADDRESSES.
 */

import * as StellarSdk from '@stellar/stellar-sdk';
import {
  CONTRACT_ADDRESSES,
  NETWORK_PASSPHRASE,
  SOROBAN_RPC_URL,
} from './stellar-utils';

/** Shape returned by Registry.get_protocol_config (snake_case via scValToNative). */
export interface ProtocolConfig {
  account_manager: string;
  oracle: string;
  tracking_token: string;
  xlm: string;
  usdc: string;
  blend_pool: string | null;
  aquarius_router: string | null;
  soroswap_router: string | null;
  /** Pool index bytes when set; otherwise null. */
  aquarius_pool_index: Buffer | Uint8Array | null;
}

type AddressBag = typeof CONTRACT_ADDRESSES & {
  XLM_TOKEN?: string;
  USDC_TOKEN?: string;
};

const CACHE_TTL_MS = 30_000;

let cachedConfig: ProtocolConfig | null = null;
let cachedAt = 0;

function addrs(): AddressBag {
  return CONTRACT_ADDRESSES as AddressBag;
}

/** Canonical XLM SAC — prefer XLM_TOKEN, else BLEND_XLM. */
export function fallbackXlmAddress(): string {
  const a = addrs();
  return a.XLM_TOKEN || a.BLEND_XLM;
}

/** Canonical USDC SAC — prefer USDC_TOKEN, else BLEND_USDC. */
export function fallbackUsdcAddress(): string {
  const a = addrs();
  return a.USDC_TOKEN || a.BLEND_USDC;
}

function fallbackConfig(): ProtocolConfig {
  const a = addrs();
  return {
    account_manager: a.ACCOUNT_MANAGER || '',
    oracle: a.ORACLE || '',
    tracking_token: a.TRACKING_TOKEN || '',
    xlm: fallbackXlmAddress(),
    usdc: fallbackUsdcAddress(),
    blend_pool: a.BLEND_POOL || null,
    aquarius_router: a.AQUARIUS_ROUTER || null,
    soroswap_router: a.SOROSWAP_ROUTER || null,
    aquarius_pool_index: a.AQUARIUS_POOL_INDEX_HEX
      ? Buffer.from(a.AQUARIUS_POOL_INDEX_HEX, 'hex')
      : null,
  };
}

function normalizeOptionalAddress(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value === 'string') return value;
  return String(value);
}

function normalizePoolIndex(value: unknown): Buffer | Uint8Array | null {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string' && /^[0-9a-fA-F]+$/.test(value) && value.length === 64) {
    return Buffer.from(value, 'hex');
  }
  return null;
}

function parseProtocolConfig(raw: unknown): ProtocolConfig {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const fb = fallbackConfig();
  return {
    account_manager: normalizeOptionalAddress(obj.account_manager) || fb.account_manager,
    oracle: normalizeOptionalAddress(obj.oracle) || fb.oracle,
    tracking_token: normalizeOptionalAddress(obj.tracking_token) || fb.tracking_token,
    xlm: normalizeOptionalAddress(obj.xlm) || fb.xlm,
    usdc: normalizeOptionalAddress(obj.usdc) || fb.usdc,
    blend_pool: normalizeOptionalAddress(obj.blend_pool) ?? fb.blend_pool,
    aquarius_router: normalizeOptionalAddress(obj.aquarius_router) ?? fb.aquarius_router,
    soroswap_router: normalizeOptionalAddress(obj.soroswap_router) ?? fb.soroswap_router,
    aquarius_pool_index: normalizePoolIndex(obj.aquarius_pool_index) ?? fb.aquarius_pool_index,
  };
}

/** Drop the in-memory cache (e.g. after admin rewires Registry). */
export function clearProtocolConfigCache(): void {
  cachedConfig = null;
  cachedAt = 0;
}

/**
 * Fetch ProtocolConfig from Registry.get_protocol_config, with a short TTL cache.
 * Falls back to CONTRACT_ADDRESSES when Registry is empty/unavailable.
 */
export async function getProtocolConfig(): Promise<ProtocolConfig> {
  const now = Date.now();
  if (cachedConfig && now - cachedAt < CACHE_TTL_MS) {
    return cachedConfig;
  }

  const registryId = CONTRACT_ADDRESSES.REGISTRY;
  if (!registryId) {
    cachedConfig = fallbackConfig();
    cachedAt = now;
    return cachedConfig;
  }

  try {
    const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
    const tempKeypair = StellarSdk.Keypair.random();
    const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');
    const contract = new StellarSdk.Contract(registryId);

    const tx = new StellarSdk.TransactionBuilder(tempAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call('get_protocol_config'))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
      console.warn('[protocol-config] get_protocol_config sim failed — using CONTRACT_ADDRESSES fallback');
      cachedConfig = fallbackConfig();
      cachedAt = now;
      return cachedConfig;
    }

    cachedConfig = parseProtocolConfig(StellarSdk.scValToNative(sim.result.retval));
    cachedAt = now;
    return cachedConfig;
  } catch (error) {
    console.warn('[protocol-config] get_protocol_config error — using fallback:', error);
    cachedConfig = fallbackConfig();
    cachedAt = now;
    return cachedConfig;
  }
}

export async function getBlendPoolAddress(): Promise<string | null> {
  const cfg = await getProtocolConfig();
  return cfg.blend_pool || CONTRACT_ADDRESSES.BLEND_POOL || null;
}

export async function getAquariusRouter(): Promise<string | null> {
  const cfg = await getProtocolConfig();
  return cfg.aquarius_router || CONTRACT_ADDRESSES.AQUARIUS_ROUTER || null;
}

export async function getSoroswapRouter(): Promise<string | null> {
  const cfg = await getProtocolConfig();
  return cfg.soroswap_router || CONTRACT_ADDRESSES.SOROSWAP_ROUTER || null;
}

export async function getXlmAddress(): Promise<string> {
  const cfg = await getProtocolConfig();
  return cfg.xlm || fallbackXlmAddress();
}

export async function getUsdcAddress(): Promise<string> {
  const cfg = await getProtocolConfig();
  return cfg.usdc || fallbackUsdcAddress();
}
