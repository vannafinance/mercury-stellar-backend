import * as StellarSdk from '@stellar/stellar-sdk';
import { signTransaction } from '@stellar/freighter-api';
import { CONTRACT_ADDRESSES, NETWORK_PASSPHRASE, SOROBAN_RPC_URL, ContractService } from './stellar-utils';

// Blend action enum variants (must match SmartAccExternalAction in smart contract)
export type BlendAction = 'Deposit' | 'Withdraw';

// Asset display info (icons/UI only — pool address is fetched from Registry at runtime)
export interface BlendPoolAsset {
  symbol: string;
  trackingSymbol: string; // symbol used in tracking token contract
  iconPath: string;
  decimals: number;
}

/**
 * Asset display configuration for Blend pools.
 * NOTE: There is ONE Blend Capital pool contract that handles all assets.
 * The pool address is NOT per-token — it is fetched dynamically from the Registry
 * via `get_blend_pool_address()`.
 */
export const BLEND_POOL_ASSETS: BlendPoolAsset[] = [
  {
    symbol: 'XLM',
    trackingSymbol: 'BLEND_XLM',
    iconPath: '/coins/xlmbg.png',
    decimals: 7,
  },
  {
    symbol: 'USDC',
    trackingSymbol: 'BLEND_USDC',
    iconPath: '/icons/usdc-icon.svg',
    decimals: 7,
  },
];

// Transaction result type
export interface BlendTransactionResult {
  success: boolean;
  hash?: string;
  error?: string;
}

// Blend balance info
export interface BlendBalanceInfo {
  bTokenBalance: string;
  underlyingBalance: string;
}

// Blend pool stats
export interface BlendPoolStats {
  supplyApy: string;
  borrowApy: string;
  totalSupply: string;
  totalBorrow: string;
  utilizationRate: string;
  bRate: string;
}

// Blend reserve data from get_reserve
export interface BlendReserveData {
  totalSupply: string;     // human-readable token amount (e.g. "54321.12")
  totalBorrow: string;     // human-readable token amount
  utilizationRate: string; // percentage string e.g. "73.50"
  supplyAPY: string;       // percentage string e.g. "5.23"
  borrowAPY: string;       // percentage string e.g. "12.45"
  bRate: string;           // exchange rate e.g. "1.0582"
  decimals: number;
}

// User's Blend position for one token
export interface BlendUserPosition {
  bTokenBalance: string;    // raw b-token balance (human-readable)
  underlyingValue: string;  // underlying value = bTokens * bRate
  tokenSymbol: string;
}

// Blend supply/withdraw event
export interface BlendEvent {
  type: 'supply' | 'withdraw';
  tokenAddress: string;
  tokenSymbol: string;
  underlyingAmount: string;
  bTokenAmount: string;
  timestamp: number;      // ledger close time (unix)
  txHash: string;
  ledger: number;
}

export class BlendService {
  /**
   * Fetch the Blend Capital pool address from the Registry contract.
   * Returns null if no Blend pool is configured.
   *
   * Registry method: `has_blend_pool_address()` → bool, `get_blend_pool_address()` → Address
   */
  static async getBlendPoolAddressFromRegistry(): Promise<string | null> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');
      const contract = new StellarSdk.Contract(CONTRACT_ADDRESSES.REGISTRY);

      // Step 1: Check if blend pool is configured
      const hasTx = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call('has_blend_pool_address'))
        .setTimeout(30)
        .build();

      const hasSim = await server.simulateTransaction(hasTx);
      if (!StellarSdk.rpc.Api.isSimulationSuccess(hasSim) || !hasSim.result?.retval) {
        console.warn('[BlendService] has_blend_pool_address simulation failed');
        return null;
      }

      const hasBlend = StellarSdk.scValToNative(hasSim.result.retval);
      if (!hasBlend) {
        console.warn('[BlendService] Blend pool is not configured in Registry');
        return null;
      }

      // Step 2: Get the actual address
      const getTx = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call('get_blend_pool_address'))
        .setTimeout(30)
        .build();

      const getSim = await server.simulateTransaction(getTx);
      if (!StellarSdk.rpc.Api.isSimulationSuccess(getSim) || !getSim.result?.retval) {
        console.warn('[BlendService] get_blend_pool_address simulation failed');
        return null;
      }

      const address = StellarSdk.scValToNative(getSim.result.retval);
      console.log('[BlendService] Blend pool address from Registry:', address);
      return address as string;
    } catch (error: any) {
      console.error('[BlendService] getBlendPoolAddressFromRegistry error:', error);
      return null;
    }
  }

  /**
   * Build the ExternalProtocolCall XDR bytes for a Blend deposit or withdraw.
   *
   * The struct is serialized as ScVal::Map with alphabetically sorted keys:
   *   amount_in, amount_out, fee_fraction, is_token_pair, margin_account,
   *   min_liquidity_out, protocol_address, token_pair_ratio, tokens_in,
   *   tokens_out, type_action
   *
   * @param blendPoolAddress - The Blend Capital pool address from Registry
   * @param action - 'Deposit' or 'Withdraw'
  * @param tokenSymbol - 'XLM' or 'USDC'
   * @param amountWad - Amount in WAD (18 decimals)
   * @param marginAccountAddress - User's smart account address
   */
  static buildExternalProtocolCallBytes(
    blendPoolAddress: string,
    action: BlendAction,
    tokenSymbol: string,
    amountWad: bigint,
    marginAccountAddress: string
  ): Buffer {
    const makeKey = (name: string) => StellarSdk.xdr.ScVal.scvSymbol(name);

    // amount_in: Vec<U256> = [] (empty for Blend)
    const amountIn = StellarSdk.xdr.ScVal.scvVec([]);

    // amount_out: Vec<U256> = [amountWad]
    const amountOut = StellarSdk.xdr.ScVal.scvVec([
      StellarSdk.nativeToScVal(amountWad, { type: 'u256' }),
    ]);

    // fee_fraction: u32 = 0
    const feeFraction = StellarSdk.xdr.ScVal.scvU32(0);

    // is_token_pair: bool = false
    const isTokenPair = StellarSdk.xdr.ScVal.scvBool(false);

    // margin_account: Address (the smart account)
    const marginAccount = StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' });

    // min_liquidity_out: U256 = 0
    const minLiquidityOut = StellarSdk.nativeToScVal(BigInt(0), { type: 'u256' });

    // protocol_address: Address = Blend Capital pool address (from Registry)
    const protocolAddress = StellarSdk.nativeToScVal(blendPoolAddress, { type: 'address' });

    // token_pair_ratio: u64 = 0
    const tokenPairRatio = StellarSdk.xdr.ScVal.scvU64(
      StellarSdk.xdr.Uint64.fromString('0')
    );

    // tokens_in: Vec<Symbol> = [] (empty for Blend)
    const tokensIn = StellarSdk.xdr.ScVal.scvVec([]);

    // tokens_out: Vec<Symbol> = [tokenSymbol] — tells contract which asset to deposit
    const tokensOut = StellarSdk.xdr.ScVal.scvVec([
      StellarSdk.xdr.ScVal.scvSymbol(tokenSymbol),
    ]);

    // type_action: SmartAccExternalAction = 'Deposit' or 'Withdraw'
    // Soroban #[contracttype] enum unit variants are encoded as Vec([Symbol("VariantName")]),
    // NOT as a bare Symbol. Using bare scvSymbol causes from_xdr to fail with UnreachableCodeReached.
    const typeAction = StellarSdk.xdr.ScVal.scvVec([StellarSdk.xdr.ScVal.scvSymbol(action)]);

    // Build alphabetically sorted ScVal::Map
    const mapEntries = [
      new StellarSdk.xdr.ScMapEntry({ key: makeKey('amount_in'), val: amountIn }),
      new StellarSdk.xdr.ScMapEntry({ key: makeKey('amount_out'), val: amountOut }),
      new StellarSdk.xdr.ScMapEntry({ key: makeKey('fee_fraction'), val: feeFraction }),
      new StellarSdk.xdr.ScMapEntry({ key: makeKey('is_token_pair'), val: isTokenPair }),
      new StellarSdk.xdr.ScMapEntry({ key: makeKey('margin_account'), val: marginAccount }),
      new StellarSdk.xdr.ScMapEntry({ key: makeKey('min_liquidity_out'), val: minLiquidityOut }),
      new StellarSdk.xdr.ScMapEntry({ key: makeKey('protocol_address'), val: protocolAddress }),
      new StellarSdk.xdr.ScMapEntry({ key: makeKey('token_pair_ratio'), val: tokenPairRatio }),
      new StellarSdk.xdr.ScMapEntry({ key: makeKey('tokens_in'), val: tokensIn }),
      new StellarSdk.xdr.ScMapEntry({ key: makeKey('tokens_out'), val: tokensOut }),
      new StellarSdk.xdr.ScMapEntry({ key: makeKey('type_action'), val: typeAction }),
    ];

    const scvMap = StellarSdk.xdr.ScVal.scvMap(mapEntries);
    return Buffer.from(scvMap.toXDR());
  }

  /**
   * Deposit tokens into the Blend Capital pool via AccountManager.execute().
   *
   * Flow:
   * 1. Fetch Blend pool address from Registry
   * 2. Build XDR-encoded ExternalProtocolCall with Deposit action
   * 3. Call AccountManager.execute(smart_account, xdr_bytes)
   */
  static async depositToBlendPool(
    walletAddress: string,
    marginAccountAddress: string,
    tokenSymbol: string,
    amount: number
  ): Promise<BlendTransactionResult> {
    try {
      // Validate token
      const assetInfo = BLEND_POOL_ASSETS.find((a) => a.symbol === tokenSymbol);
      if (!assetInfo) {
        throw new Error(`Unsupported token: ${tokenSymbol}`);
      }

      // Get the Blend pool address from Registry.
      const registryAddr = await BlendService.getBlendPoolAddressFromRegistry();
      if (!registryAddr) {
        return {
          success: false,
          error:
            'Blend pool is not configured in the Registry. Ask the admin to run set_blend_pool_address before depositing XLM.',
        };
      }
      const blendPoolAddress = registryAddr;
      console.log('[BlendService] Using Blend pool address:', blendPoolAddress, '(from Registry)');

      // Convert amount to WAD (18 decimals)
      const amountWad = BigInt(Math.floor(amount * 1e18));

      const callBytes = BlendService.buildExternalProtocolCallBytes(
        blendPoolAddress,
        'Deposit',
        tokenSymbol,
        amountWad,
        marginAccountAddress
      );

      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(walletAddress);
      const contract = new StellarSdk.Contract(CONTRACT_ADDRESSES.ACCOUNT_MANAGER);

      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: (parseInt(StellarSdk.BASE_FEE) * 20).toString(),
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            'execute',
            StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' }),
            StellarSdk.xdr.ScVal.scvBytes(callBytes)
          )
        )
        .setTimeout(30)
        .build();

      console.log('[BlendService] Preparing deposit transaction...');
      const preparedTx = await server.prepareTransaction(transaction);

      const signResult = await signTransaction(preparedTx.toXDR(), {
        networkPassphrase: NETWORK_PASSPHRASE,
      });

      const signedTx = StellarSdk.TransactionBuilder.fromXDR(
        signResult.signedTxXdr,
        NETWORK_PASSPHRASE
      );

      console.log('[BlendService] Sending deposit transaction...');
      const result = await server.sendTransaction(signedTx as StellarSdk.Transaction);

      if (result.status === 'PENDING') {
        await BlendService.pollTransactionStatus(server, result.hash);
        return { success: true, hash: result.hash };
      } else {
        throw new Error('Transaction rejected by network');
      }
    } catch (error: any) {
      console.error('[BlendService] Deposit error:', error);
      return { success: false, error: error?.message || 'Deposit failed' };
    }
  }

  /**
   * Withdraw tokens from the Blend Capital pool via AccountManager.execute().
   *
   * Flow:
   * 1. Fetch Blend pool address from Registry
   * 2. Build XDR-encoded ExternalProtocolCall with Withdraw action
   * 3. Call AccountManager.execute(smart_account, xdr_bytes)
   */
  static async withdrawFromBlendPool(
    walletAddress: string,
    marginAccountAddress: string,
    tokenSymbol: string,
    amount: number
  ): Promise<BlendTransactionResult> {
    try {
      const assetInfo = BLEND_POOL_ASSETS.find((a) => a.symbol === tokenSymbol);
      if (!assetInfo) {
        throw new Error(`Unsupported token: ${tokenSymbol}`);
      }

      // Get the Blend pool address from Registry.
      const registryAddr = await BlendService.getBlendPoolAddressFromRegistry();
      if (!registryAddr) {
        return {
          success: false,
          error:
            'Blend pool is not configured in the Registry. Ask the admin to run set_blend_pool_address before withdrawing XLM.',
        };
      }
      const blendPoolAddress = registryAddr;
      console.log('[BlendService] Using Blend pool address:', blendPoolAddress, '(from Registry)');

      // Convert amount to WAD (18 decimals)
      const amountWad = BigInt(Math.floor(amount * 1e18));

      const callBytes = BlendService.buildExternalProtocolCallBytes(
        blendPoolAddress,
        'Withdraw',
        tokenSymbol,
        amountWad,
        marginAccountAddress
      );

      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(walletAddress);
      const contract = new StellarSdk.Contract(CONTRACT_ADDRESSES.ACCOUNT_MANAGER);

      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: (parseInt(StellarSdk.BASE_FEE) * 20).toString(),
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            'execute',
            StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' }),
            StellarSdk.xdr.ScVal.scvBytes(callBytes)
          )
        )
        .setTimeout(30)
        .build();

      console.log('[BlendService] Preparing withdraw transaction...');
      const preparedTx = await server.prepareTransaction(transaction);

      const signResult = await signTransaction(preparedTx.toXDR(), {
        networkPassphrase: NETWORK_PASSPHRASE,
      });

      const signedTx = StellarSdk.TransactionBuilder.fromXDR(
        signResult.signedTxXdr,
        NETWORK_PASSPHRASE
      );

      console.log('[BlendService] Sending withdraw transaction...');
      const result = await server.sendTransaction(signedTx as StellarSdk.Transaction);

      if (result.status === 'PENDING') {
        await BlendService.pollTransactionStatus(server, result.hash);
        return { success: true, hash: result.hash };
      } else {
        throw new Error('Transaction rejected by network');
      }
    } catch (error: any) {
      console.error('[BlendService] Withdraw error:', error);
      return { success: false, error: error?.message || 'Withdraw failed' };
    }
  }

  /**
   * Get user's Blend supply balance for a given token.
   *
   * Reads the tracking token balance from the TrackingToken contract.
  * The tracking symbols are: BLEND_XLM, BLEND_USDC
   * (set by AccountManager after a successful Blend deposit).
   */
  static async getUserBlendBalance(
    marginAccountAddress: string,
    tokenSymbol: 'XLM' | 'USDC'
  ): Promise<BlendBalanceInfo> {
    try {
      const assetInfo = BLEND_POOL_ASSETS.find((a) => a.symbol === tokenSymbol);
      if (!assetInfo) {
        throw new Error(`Unsupported token: ${tokenSymbol}`);
      }

      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');

      // Get tracking token contract from Registry
      const registryContract = new StellarSdk.Contract(CONTRACT_ADDRESSES.REGISTRY);
      const trackingAddrTx = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(registryContract.call('get_tracking_token_contract_addr'))
        .setTimeout(30)
        .build();

      const trackingAddrSim = await server.simulateTransaction(trackingAddrTx);
      if (!StellarSdk.rpc.Api.isSimulationSuccess(trackingAddrSim) || !trackingAddrSim.result?.retval) {
        return { bTokenBalance: '0', underlyingBalance: '0' };
      }
      const trackingTokenAddress = StellarSdk.scValToNative(trackingAddrSim.result.retval) as string;

      // Call balance(margin_account, tracking_symbol)
      const trackingContract = new StellarSdk.Contract(trackingTokenAddress);
      const balanceTx = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          trackingContract.call(
            'balance',
            StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' }),
            StellarSdk.xdr.ScVal.scvSymbol(assetInfo.trackingSymbol)
          )
        )
        .setTimeout(30)
        .build();

      const balanceSim = await server.simulateTransaction(balanceTx);
      if (StellarSdk.rpc.Api.isSimulationSuccess(balanceSim) && balanceSim.result?.retval) {
        const raw = StellarSdk.scValToNative(balanceSim.result.retval);
        // Tracking token balance is in b-tokens (Blend's internal representation, 7 decimals)
        const balanceNum = Number(raw) / 1e7;
        const reserve = await BlendService.getBlendReserveData(tokenSymbol);
        const bRate = reserve ? parseFloat(reserve.bRate) : 1;
        const underlying = balanceNum * bRate;

        return {
          bTokenBalance: balanceNum.toFixed(7),
          underlyingBalance: underlying.toFixed(7),
        };
      }

      return { bTokenBalance: '0', underlyingBalance: '0' };
    } catch (error: any) {
      console.error('[BlendService] getUserBlendBalance error:', error);
      return { bTokenBalance: '0', underlyingBalance: '0' };
    }
  }

  /**
   * Get the actual token balance held by a margin account for Blend-supported assets.
   * Uses token.balance(marginAccountAddress) on Blend asset contracts directly.
   */
  static async getMarginAccountTokenBalance(
    marginAccountAddress: string,
    token: 'XLM' | 'USDC'
  ): Promise<string> {
    try {
      const tokenContractId = token === 'XLM'
        ? CONTRACT_ADDRESSES.BLEND_XLM
        : CONTRACT_ADDRESSES.BLEND_USDC;

      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');
      const tokenContract = new StellarSdk.Contract(tokenContractId);

      const tx = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          tokenContract.call(
            'balance',
            StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' }),
          )
        )
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      if ('error' in sim || !('result' in sim) || !sim.result) return '0';

      const raw = StellarSdk.scValToNative(sim.result.retval) as bigint;
      return (Number(raw) / 1e7).toFixed(7);
    } catch {
      return '0';
    }
  }

  /**
   * Fetch the tracking token contract address from the Registry.
   * This is the contract that stores b-token balances for margin accounts.
   * Users can add this token contract to their wallet to monitor their Blend positions.
   */
  static async getTrackingTokenContractAddress(): Promise<string | null> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');
      const registryContract = new StellarSdk.Contract(CONTRACT_ADDRESSES.REGISTRY);

      const tx = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(registryContract.call('get_tracking_token_contract_addr'))
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
        return null;
      }
      return StellarSdk.scValToNative(sim.result.retval) as string;
    } catch (error: any) {
      console.error('[BlendService] getTrackingTokenContractAddress error:', error);
      return null;
    }
  }

  /**
   * Check if the Blend pool is configured.
   * Blend actions require Registry.BlendPoolContract to be present so the
   * smart account can route the call to the correct protocol branch.
   */
  static async isBlendPoolConfigured(): Promise<boolean> {
    return (await BlendService.getBlendPoolAddressFromRegistry()) !== null;
  }

  /**
   * Admin function: Call Registry.set_blend_pool_address() to configure the Blend pool.
   *
   * ⚠️  CRITICAL: This MUST be called by the admin wallet BEFORE any Blend deposit/withdraw
   * can succeed. Without it, SmartAccount.execute() panics:
   *   "No external protocol mapped for the given protocol address"
   *   → HostError: Error(WasmVm, InvalidAction) / UnreachableCodeReached
   *
   * @param adminAddress - Must be the protocol admin wallet address
   */
  static async adminSetBlendPoolAddress(
    adminAddress: string
  ): Promise<BlendTransactionResult> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const adminAccount = await server.getAccount(adminAddress);
      const registryContract = new StellarSdk.Contract(CONTRACT_ADDRESSES.REGISTRY);

      const transaction = new StellarSdk.TransactionBuilder(adminAccount, {
        fee: (parseInt(StellarSdk.BASE_FEE) * 10).toString(),
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          registryContract.call(
            'set_blend_pool_address',
            StellarSdk.nativeToScVal(CONTRACT_ADDRESSES.BLEND_POOL, { type: 'address' })
          )
        )
        .setTimeout(30)
        .build();

      console.log('[BlendService] Preparing set_blend_pool_address transaction...');
      const preparedTx = await server.prepareTransaction(transaction);

      const signResult = await signTransaction(preparedTx.toXDR(), {
        networkPassphrase: NETWORK_PASSPHRASE,
      });

      const signedTx = StellarSdk.TransactionBuilder.fromXDR(
        signResult.signedTxXdr,
        NETWORK_PASSPHRASE
      );

      const result = await server.sendTransaction(signedTx as StellarSdk.Transaction);
      if (result.status === 'PENDING') {
        await BlendService.pollTransactionStatus(server, result.hash);
        console.log('[BlendService] ✓ Blend pool address set in Registry:', CONTRACT_ADDRESSES.BLEND_POOL);
        return { success: true, hash: result.hash };
      } else {
        throw new Error('Transaction rejected by network');
      }
    } catch (error: any) {
      console.error('[BlendService] adminSetBlendPoolAddress error:', error);
      return { success: false, error: error?.message || 'Failed to set Blend pool address' };
    }
  }

  /**
   * Get Blend pool stats by querying the Blend Capital pool contract.
   * Gets reserve data (b_rate, supply rate, borrow rate) for a specific asset.
   */
  static async getBlendPoolStats(_blendPoolAddress: string): Promise<BlendPoolStats> {
    const data = await BlendService.getBlendReserveData('XLM');
    if (!data) {
      return { supplyApy: '0.00', borrowApy: '0.00', totalSupply: '0', totalBorrow: '0', utilizationRate: '0', bRate: '1.0000' };
    }
    return {
      supplyApy: data.supplyAPY,
      borrowApy: data.borrowAPY,
      totalSupply: data.totalSupply,
      totalBorrow: data.totalBorrow,
      utilizationRate: data.utilizationRate,
      bRate: data.bRate,
    };
  }

  /**
   * Get real reserve data for a specific asset from the Blend pool contract.
   * Calls get_reserve(asset_address) and calculates APY, TVL, utilization.
   */
  static async getBlendReserveData(
    tokenSymbol: 'XLM' | 'USDC',
    blendPoolAddress?: string
  ): Promise<BlendReserveData | null> {
    // Asset contract addresses in the Blend pool
    const assetAddresses: Record<string, string> = {
      XLM: CONTRACT_ADDRESSES.BLEND_XLM,
      USDC: CONTRACT_ADDRESSES.BLEND_USDC,
    };

    const assetAddress = assetAddresses[tokenSymbol];
    if (!assetAddress) return null;

    const poolAddress = blendPoolAddress ?? CONTRACT_ADDRESSES.BLEND_POOL;

    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');
      const contract = new StellarSdk.Contract(poolAddress);

      // Call get_reserve(asset_address)
      const tx = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            'get_reserve',
            StellarSdk.nativeToScVal(assetAddress, { type: 'address' })
          )
        )
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
        console.warn(`[BlendService] get_reserve failed for ${tokenSymbol}`);
        return null;
      }

      const reserve = StellarSdk.scValToNative(sim.result.retval) as any;
      return BlendService._parseReserveData(reserve);
    } catch (err: any) {
      console.error(`[BlendService] getBlendReserveData(${tokenSymbol}) error:`, err);
      return null;
    }
  }

  /** Parse raw reserve data from scValToNative into BlendReserveData. */
  static _parseReserveData(reserve: any): BlendReserveData {
    const SCALAR_7 = 1e7;
    const SCALAR_9 = 1e9;
    const SCALAR_12 = 1e12; // Blend uses 1e12 precision for b_rate and d_rate accumulators
    const LEDGERS_PER_YEAR = 6_307_200; // 365d * 24h * 3600s / 5s per ledger

    // b_rate and d_rate are stored with SCALAR_12 (1e12) precision in Blend Capital
    const bRate = Number(reserve.data.b_rate);      // raw, precision 1e12
    const bSupply = Number(reserve.data.b_supply);   // b-tokens (7-decimal)
    const dRate = Number(reserve.data.d_rate);       // raw, precision 1e12
    const dSupply = Number(reserve.data.d_supply);   // d-tokens (7-decimal)
    // ir_mod uses SCALAR_12 precision in Blend (1_000_000_000_000 = 1.0x multiplier)
    const irMod = Number(reserve.data.ir_mod);       // precision 1e12
    const decimals: number = Number(reserve.config.decimals);

    // IR curve parameters (all in SCALAR_9 units)
    const rBase = Number(reserve.config.r_base);
    const rOne = Number(reserve.config.r_one);
    const rTwo = Number(reserve.config.r_two);
    const rThree = Number(reserve.config.r_three);
    const targetUtil = Number(reserve.config.util);  // in SCALAR_7

    // Total underlying supply/borrow for display (human-readable token amounts)
    const totalSupplyRaw = (bSupply / SCALAR_7) * (bRate / SCALAR_12);
    const totalBorrowRaw = (dSupply / SCALAR_7) * (dRate / SCALAR_12);

    // Underlying utilization (for display and supply APR calculation)
    const utilization = totalSupplyRaw > 0 ? totalBorrowRaw / totalSupplyRaw : 0;

    // Blend's IR curve uses the UNDERLYING VALUE utilization (matching Blend UI exactly)
    const utilForIR = utilization;  // totalBorrow / totalSupply (underlying ratio)
    const targetUtilDecimal = targetUtil / SCALAR_7;          // e.g. 0.75

    // Blend interest rate curve:
    //   r_* are in SCALAR_9 → convert to decimal first
    let rateDecimal: number;
    if (utilForIR <= targetUtilDecimal) {
      rateDecimal = rBase / SCALAR_9 +
        (rOne / SCALAR_9) * (targetUtilDecimal > 0 ? utilForIR / targetUtilDecimal : 0);
    } else {
      const extra = (utilForIR - targetUtilDecimal) / (1 - targetUtilDecimal);
      rateDecimal = rOne / SCALAR_9 +
        (rTwo / SCALAR_9) * extra +
        (rThree / SCALAR_9) * extra * extra;
    }

    // ir_mod is SCALAR_12 → convert to decimal multiplier (1e12 = 1.0x)
    const irModDecimal = irMod / SCALAR_12;
    const perLedgerDecimal = rateDecimal * irModDecimal;

    // Blend UI displays SIMPLE APR (not compound APY):
    //   simple APR = perLedger * LEDGERS_PER_YEAR
    // (compound APY would be (1+perLedger)^LEDGERS_PER_YEAR-1 which is ~2.4x higher and doesn't match Blend UI)
    const borrowAPR = perLedgerDecimal * LEDGERS_PER_YEAR * 100;

    // Supply APR = borrow APR * underlying_utilization * (1 - backstop_take_rate)
    // Blend testnet pool has backstop_take_rate ≈ 0.25 (25%).
    // This can be fetched from pool_config().bstop_rate / 1e7 if needed dynamically.
    const BACKSTOP_RATE = 0.25;
    const supplyAPY = borrowAPR * utilization * (1 - BACKSTOP_RATE);

    return {
      totalSupply: totalSupplyRaw.toFixed(decimals > 4 ? 4 : decimals),
      totalBorrow: totalBorrowRaw.toFixed(decimals > 4 ? 4 : decimals),
      utilizationRate: (utilization * 100).toFixed(2),
      supplyAPY: Math.max(0, supplyAPY).toFixed(2),
      borrowAPY: Math.max(0, borrowAPR).toFixed(2),
      bRate: (bRate / SCALAR_12).toFixed(7),
      decimals,
    };
  }

  /**
   * Get Blend reserve stats (XLM, USDC) in parallel.
   */
  static async getAllBlendReserveStats(): Promise<Record<string, BlendReserveData | null>> {
    const [xlm, usdc] = await Promise.all([
      BlendService.getBlendReserveData('XLM'),
      BlendService.getBlendReserveData('USDC'),
    ]);
    return { XLM: xlm, USDC: usdc };
  }

  /**
   * Get user's Blend supply positions for all tokens via tracking token contract.
   * Returns b-token balance and estimated underlying value per token.
   */
  static async getAllUserBlendPositions(
    marginAccountAddress: string
  ): Promise<Record<string, BlendUserPosition>> {
    const assets = BLEND_POOL_ASSETS;
    const empty = (): BlendUserPosition => ({ bTokenBalance: '0', underlyingValue: '0', tokenSymbol: '' });
    const result: Record<string, BlendUserPosition> = {
      XLM: empty(), USDC: empty(),
    };

    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');

      // Fetch tracking token contract address from Registry
      const regContract = new StellarSdk.Contract(CONTRACT_ADDRESSES.REGISTRY);
      const trackAddrTx = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE,
      }).addOperation(regContract.call('get_tracking_token_contract_addr')).setTimeout(30).build();

      const trackAddrSim = await server.simulateTransaction(trackAddrTx);
      if (!StellarSdk.rpc.Api.isSimulationSuccess(trackAddrSim) || !trackAddrSim.result?.retval) {
        return result;
      }
      const trackingAddress = StellarSdk.scValToNative(trackAddrSim.result.retval) as string;
      const trackContract = new StellarSdk.Contract(trackingAddress);

      // Fetch b-rates for value calculation
      const [xlmReserve, usdcReserve] = await Promise.all([
        BlendService.getBlendReserveData('XLM'),
        BlendService.getBlendReserveData('USDC'),
      ]);
      const bRates: Record<string, number> = {
        XLM: xlmReserve ? parseFloat(xlmReserve.bRate) : 1,
        USDC: usdcReserve ? parseFloat(usdcReserve.bRate) : 1,
      };

      // Fetch balances for each tracking symbol in parallel
      const balancePromises = assets.map(async (asset) => {
        const balTx = new StellarSdk.TransactionBuilder(tempAccount, {
          fee: StellarSdk.BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE,
        }).addOperation(
          trackContract.call(
            'balance',
            StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' }),
            StellarSdk.xdr.ScVal.scvSymbol(asset.trackingSymbol)
          )
        ).setTimeout(30).build();

        const balSim = await server.simulateTransaction(balTx);
        if (StellarSdk.rpc.Api.isSimulationSuccess(balSim) && balSim.result?.retval) {
          const raw = Number(StellarSdk.scValToNative(balSim.result.retval));
          const bTokens = raw / 1e7; // tracking token uses 7 decimals
          const underlying = bTokens * bRates[asset.symbol];
          return {
            symbol: asset.symbol,
            bTokenBalance: bTokens.toFixed(7),
            underlyingValue: underlying.toFixed(7),
          };
        }
        return { symbol: asset.symbol, bTokenBalance: '0', underlyingValue: '0' };
      });

      const balances = await Promise.all(balancePromises);
      for (const b of balances) {
        result[b.symbol] = { bTokenBalance: b.bTokenBalance, underlyingValue: b.underlyingValue, tokenSymbol: b.symbol };
      }
    } catch (err: any) {
      console.error('[BlendService] getAllUserBlendPositions error:', err);
    }
    return result;
  }

  /**
   * Fetch supply/withdraw events for a margin account from the Blend pool.
   * Uses Soroban RPC getEvents to find historical events.
   */
  static async getBlendEvents(
    marginAccountAddress: string,
    blendPoolAddress?: string
  ): Promise<BlendEvent[]> {
    const registryPoolAddress = await BlendService.getBlendPoolAddressFromRegistry();
    const poolAddress = blendPoolAddress ?? registryPoolAddress ?? CONTRACT_ADDRESSES.BLEND_POOL;
    const assetMap: Record<string, string> = {
      [CONTRACT_ADDRESSES.BLEND_XLM]: 'XLM',
      [CONTRACT_ADDRESSES.BLEND_USDC]: 'USDC',
    };

    try {
      if (!poolAddress || typeof poolAddress !== 'string') {
        return [];
      }
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);

      // Get current ledger to set a reasonable start ledger (last ~30 days ≈ 518400 ledgers)
      const ledgerResp = await server.getLatestLedger();
      const startLedger = Math.max(1, ledgerResp.sequence - 518400);

      // Topics: only filter by action symbol (supply/withdraw) — filter account client-side.
      // Passing account address as topic causes XDR decode errors on some RPC nodes.
      const supplyTopic = StellarSdk.xdr.ScVal.scvSymbol('supply').toXDR('base64');
      const withdrawTopic = StellarSdk.xdr.ScVal.scvSymbol('withdraw').toXDR('base64');

      // Fetch supply events (all for pool, filter by account below)
      const safeGetEvents = async (topic: string) => {
        try {
          const resp = await server.getEvents({
            startLedger,
            filters: [{
              type: 'contract',
              contractIds: [poolAddress],
              topics: [[topic]],
            }],
            limit: 200,
          } as any);
          if ((resp as any)?.error) return [];
          return (resp as any)?.events ?? [];
        } catch {
          return [];
        }
      };

      const supplyEvents = await safeGetEvents(supplyTopic);
      const withdrawEvents = await safeGetEvents(withdrawTopic);

      const parseEvents = (events: any[], eventType: 'supply' | 'withdraw'): BlendEvent[] => {
        const results: BlendEvent[] = [];
        for (const ev of events ?? []) {
          try {
            const topics = ev.topic?.map((t: any) => StellarSdk.scValToNative(t));
            // topics[2] or topics[1] may hold the "from" address depending on pool contract version
            const fromAddress = (topics?.[2] ?? topics?.[1]) as string;
            if (fromAddress && fromAddress !== marginAccountAddress) continue;
            const data = ev.value ? StellarSdk.scValToNative(ev.value) : null;
            const tokenAddress = topics?.[1] as string;
            const [underlying, bTokens] = Array.isArray(data) ? data.map(Number) : [0, 0];
            results.push({
              type: eventType,
              tokenAddress,
              tokenSymbol: assetMap[tokenAddress] ?? tokenAddress?.slice(0, 8) ?? '?',
              underlyingAmount: (underlying / 1e7).toFixed(7),
              bTokenAmount: (bTokens / 1e7).toFixed(7),
              timestamp: ev.ledgerClosedAt ? new Date(ev.ledgerClosedAt).getTime() : 0,
              txHash: ev.txHash ?? '',
              ledger: ev.ledger ?? 0,
            });
          } catch {/* skip malformed events */}
        }
        return results;
      };

      const events: BlendEvent[] = [
        ...parseEvents(supplyEvents, 'supply'),
        ...parseEvents(withdrawEvents, 'withdraw'),
      ];

      // Sort by timestamp descending
      events.sort((a, b) => b.timestamp - a.timestamp);
      return events;
    } catch (err: any) {
      console.warn('[BlendService] getBlendEvents error:', err?.message ?? err);
      return [];
    }
  }

  /**
   * Get wallet balance for a specific asset (XLM, USDC).
   */
  static async getWalletBalance(
    walletAddress: string,
    assetType: 'XLM' | 'USDC'
  ): Promise<string> {
    try {
      const balances = await ContractService.getAllTokenBalances(walletAddress);
      return balances[assetType] ?? '0';
    } catch (error: any) {
      console.error('[BlendService] getWalletBalance error:', error);
      return '0';
    }
  }

  /**
   * Poll for transaction confirmation.
   */
  static async pollTransactionStatus(
    server: StellarSdk.rpc.Server,
    hash: string
  ): Promise<void> {
    let attempts = 0;
    const maxAttempts = 30;

    while (attempts < maxAttempts) {
      try {
        const transaction = await server.getTransaction(hash);
        if (transaction.status !== 'NOT_FOUND') {
          if (transaction.status === 'SUCCESS') {
            return;
          } else {
            throw new Error(`Transaction failed with status: ${transaction.status}`);
          }
        }
      } catch (error: any) {
        if (error?.message?.includes('Transaction failed')) {
          throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
      attempts++;
    }
    throw new Error('Transaction timed out waiting for confirmation');
  }
}
