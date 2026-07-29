import { requestAccess, getAddress, signTransaction } from '@/lib/wallet-adapter';
import * as StellarSdk from '@stellar/stellar-sdk';

export const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
export const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
export const HORIZON_URL = 'https://horizon-testnet.stellar.org';

// Redeployed 2026-07-11 (fresh deploy_all — full clean redeploy of every core
// contract, all 4 lending pools + vTokens, and TrackingToken, using vanna_deployer.
// Ships the Soroswap/Aquarius AddLiquidity auth-mismatch fix (router_quote
// round-trip re-derivation in SmartAccountContract) plus everything from the
// 2026-07-10 deployment (RemoveLiquidity/Blend-Withdraw budget exclusions).
// Every address below was captured directly from this deploy's own on-chain
// events, including the vTokens — no more stale-address gap. See
// CONTRACT_COMMAND.md §A7 for the full command log.
// Aligned with mercury-stellar-rewire + live MCP vanna_list_protocol_addresses
// (testnet deploy_all 2026-07-11). XLM SAC = CDLZFC3S… is set on this Registry.
export const CONTRACT_ADDRESSES = {
  REGISTRY: 'CBUR7X2M2FQIIF237GNXYJGLHNM3BB3EPEUVYBRPMXVITN4SJP6PJVW2',
  ORACLE: 'CAWF5QNGOBDZU2NHUJAJPEEPYVANA4W4DFORZLIJXZGV5YIVKWSPMRIZ',
  RATE_MODEL: 'CASLR2WN5K5I7KJACBHOMM5OXRI4JXT6QIZDW5QSD5JNATRNBWCBJEYU',
  RISK_ENGINE: 'CCEDO4CLQLM6V7CTTRHTWV73KYLJYKEKTRTVTYJKWDZICSE5PVYGQLCJ',
  ACCOUNT_MANAGER: 'CASO66NZT3QVCWWWL2TFUW5F3YW4C4IVYENRBUCBRHHRSE3NXRW3SYZP',
  TRACKING_TOKEN: 'CBH6O3O6I7DYVXAPA6IBP2O53AS4QS7AJJ5KIOOJ6R3JMRP6HGTF6KIB',

  // Native XLM SAC (Registry get_xlm_contract_address) — same as MCP xlm_contract
  XLM: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  // Blend USDC / primary USDC SAC used by lending (MCP usdc_contract)
  USDC: 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU',

  // vToken receipt contracts — fresh, matched to the pools below.
  VXLM_TOKEN: 'CBOVX53HHAJEM3KECYI66XW5NZJVNNYPGXQ4B4F5T2MJSDDK3NCENNLS',
  VUSDC_TOKEN: 'CCKRLPKII3U47ACRGYVSNT3ZZ5AA3N63HYDIQEFTWSPWLSIAEXI2XPIB',
  VBLEND_USDC_TOKEN: 'CCKRLPKII3U47ACRGYVSNT3ZZ5AA3N63HYDIQEFTWSPWLSIAEXI2XPIB',
  VAQUARIUS_USDC_TOKEN: 'CBPCN7SII4SICPNAJ44FBUYMOXE36Z7QWZ5V6VHBAFVW3DYA2QFO623C',
  VSOROSWAP_USDC_TOKEN: 'CDZ75VRBKPNEDLYU2FP2WVC2UTBC7GXRL7X4SFLOYDMEKZEJMOXRVL5B',

  // Lending Pools
  LENDING_PROTOCOL_XLM: 'CBFBE5H5UZQYNFI3IWJP3J2VIBXPQ6JPJHKZHZ3HHRXZYEZW7G3FM6QX',
  LENDING_PROTOCOL_USDC: 'CCYIBZLWBKSNJO7V7JGWVVUFOYVTHUZB72SXV7MRRQ3LTWZUHLIGRFJA',
  LENDING_PROTOCOL_BLEND_USDC: 'CCYIBZLWBKSNJO7V7JGWVVUFOYVTHUZB72SXV7MRRQ3LTWZUHLIGRFJA',
  LENDING_PROTOCOL_AQUARIUS_USDC: 'CBTJQONKFKGTUGFLOGL6WIP4ZWPFMX7AUMRRIDI5G7GJCVBLPDXD4IVD',
  LENDING_PROTOCOL_SOROSWAP_USDC: 'CAE3QRT6RBEMJVA7ENJB4TFF24BZSGENCHYKPNSNROVL2BGWOTAAESDY',

  // Blend Capital (testnet)
  BLEND_POOL: 'CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF',
  BLEND_XLM: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  BLEND_USDC: 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU',

  // Aquarius AMM (testnet)
  AQUARIUS_ROUTER: 'CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD',
  AQUARIUS_XLM_USDC_POOL: 'CD3LFMMLBQ6RBJUD3Z2LFDFE6544WDRMWHEZYPI5YDVESYRSO2TT32BX',
  AQUARIUS_USDC: 'CAZRY5GSFBFXD7H6GAFBA5YGYQTDXU4QKWKMYFWBAZFUCURN3WKX6LF5',
  AQUARIUS_POOL_INDEX_HEX: '9ac7a9cde23ac2ada11105eeaa42e43c2ea8332ca0aa8f41f58d7160274d718e',
  AQUARIUS_XLM_AQUA_POOL: 'CCSXYUVLYALKJGIIYMGYLZI447VS6TDWFTVDL43B4IKK2WERHLWUVCRC',
  AQUARIUS_XLM_USDT_POOL: 'CA6DAGOMK5D7GKBNWVCIEAYSTPJXLQUFWFKSZOMNEM6BVOTUBDCTIT5I',

  // Soroswap DEX (testnet)
  SOROSWAP_ROUTER: 'CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD',
  SOROSWAP_XLM: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  SOROSWAP_USDC: 'CB3TLW74NBIOT3BUWOZ3TUM6RFDF6A4GVIRUQRQZABG5KPOUL4JJOV2F',
  SOROSWAP_XLM_USDC_POOL: 'CDVAIOYHCD4RUSLQNVFI7RIZBFT2JZMJWM4RTOLQZQXL4QAVXU5RFKDB',
} as const;

export const ASSET_TYPES = {
  XLM: 'XLM',
  USDC: 'USDC',
  BLEND_USDC: 'BLEND_USDC',
  AQUARIUS_USDC: 'AQUARIUS_USDC',
  SOROSWAP_USDC: 'SOROSWAP_USDC',
} as const;

// Aquarius USDC classic-side issuer (for trustline/Horizon balance checks)
export const ASSET_ISSUERS = {
  USDC_AQUARIUS: 'GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER',
} as const;

export type AssetType = typeof ASSET_TYPES[keyof typeof ASSET_TYPES];

export class WalletService {
  static async connectWallet(): Promise<{ address: string; success: boolean; error?: string }> {
    try {
      // `requestAccess()` always resolves to an object, so the old `!accessGranted`
      // check never fired and a *rejected* prompt fell through to `getAddress()`.
      // Inspect the result properly and stop here, or the user gets prompted twice.
      const accessGranted = await requestAccess();
      if (accessGranted.error || !accessGranted.address) {
        const detail =
          typeof accessGranted.error === 'string' ? accessGranted.error : accessGranted.error?.message;
        return {
          address: '',
          success: false,
          error: detail || 'Please approve the connection in Freighter',
        };
      }

      const result = await getAddress();
      if (result.error) {
        const message = typeof result.error === 'string' ? result.error : result.error.message;
        return { address: '', success: false, error: message || 'Failed to connect wallet' };
      }
      
      if (!result.address) {
        return { address: '', success: false, error: 'Wallet is locked. Please unlock Freighter' };
      }
      
      return { address: result.address, success: true };
    } catch (error: any) {
      return { address: '', success: false, error: error?.message || 'Failed to connect wallet' };
    }
  }

  static async checkConnection(): Promise<{ address: string; connected: boolean }> {
    try {
      const result = await getAddress();
      if (result.address && !result.error) {
        return { address: result.address, connected: true };
      }
      return { address: '', connected: false };
    } catch (error) {
      return { address: '', connected: false };
    }
  }

  static async getBalance(address: string): Promise<string> {
    try {
      const server = new StellarSdk.Horizon.Server(HORIZON_URL);
      const account = await server.loadAccount(address);
      
      const xlmBalance = account.balances.find(
        (balance: any) => balance.asset_type === 'native'
      );
      
      return xlmBalance ? parseFloat(xlmBalance.balance).toFixed(7) : '0';
    } catch (error: any) {
      if (error?.response?.status === 404) {
        return '0 (Not funded)';
      }
      return 'Error';
    }
  }
}

export class ContractService {
  private static tokenDecimalsCache: Record<string, number> = {};

  private static async getTokenDecimals(tokenContract: string): Promise<number> {
    if (typeof this.tokenDecimalsCache[tokenContract] === 'number') {
      return this.tokenDecimalsCache[tokenContract];
    }

    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');
      const token = new StellarSdk.Contract(tokenContract);

      const tx = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(token.call('decimals'))
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      if (StellarSdk.rpc.Api.isSimulationSuccess(sim) && sim.result?.retval) {
        const decimalsNative = StellarSdk.scValToNative(sim.result.retval);
        const decimals = Number(decimalsNative);
        if (Number.isFinite(decimals) && decimals >= 0) {
          this.tokenDecimalsCache[tokenContract] = decimals;
          return decimals;
        }
      }
    } catch (error) {
      console.warn(`[getTokenDecimals] Falling back to 7 for ${tokenContract}:`, error);
    }

    this.tokenDecimalsCache[tokenContract] = 7;
    return 7;
  }

  static async getSorobanTokenWalletBalance(
    tokenContract: string,
    walletAddress: string,
    sourceUserAddress?: string,
  ): Promise<string> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(sourceUserAddress ?? walletAddress);
      const token = new StellarSdk.Contract(tokenContract);

      const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          token.call(
            'balance',
            StellarSdk.nativeToScVal(walletAddress, { type: 'address' })
          )
        )
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) return '0';

      const raw = StellarSdk.scValToNative(sim.result.retval) as bigint;
      const decimals = await this.getTokenDecimals(tokenContract);
      return (Number(raw) / 10 ** decimals).toFixed(7);
    } catch {
      return '0';
    }
  }

  static async deposit(
    walletAddress: string, 
    amount: number, 
    assetType: AssetType = ASSET_TYPES.XLM
  ): Promise<{ success: boolean; hash?: string; error?: string }> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(walletAddress);
      
      let contractAddress: string;
      let methodName: string;
      
      switch (assetType) {
        case ASSET_TYPES.XLM:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_XLM;
          break;
        case ASSET_TYPES.USDC:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_USDC;
          break;
        case ASSET_TYPES.BLEND_USDC:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_BLEND_USDC;
          break;
        case ASSET_TYPES.AQUARIUS_USDC:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_AQUARIUS_USDC;
          break;
        case ASSET_TYPES.SOROSWAP_USDC:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_SOROSWAP_USDC;
          break;
        default:
          throw new Error('Unsupported asset type');
      }
      methodName = 'deposit';

      const contract = new StellarSdk.Contract(contractAddress);

      const amountWAD = (BigInt(Math.floor(amount * 1e18))).toString();
      
      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            methodName,
            StellarSdk.nativeToScVal(walletAddress, { type: 'address' }),
            StellarSdk.nativeToScVal(amountWAD, { type: 'u256' })
          )
        )
        .setTimeout(30)
        .build();

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
        await ContractService.pollTransactionStatus(server, result.hash);
        return { success: true, hash: result.hash };
      } else {
        throw new Error('Transaction rejected by network');
      }
    } catch (error: any) {
      console.error('Deposit error:', error);
      return { success: false, error: error?.message || 'Deposit failed' };
    }
  }

  /**
   * Withdraw from a lending pool by redeeming vTokens (`redeem_vxlm` /
   * `redeem_vusdc`). Prepares → signs via Freighter → submits → polls.
   *
   * @param walletAddress - Redeemer's G-address and tx source.
   * @param amount - Human amount; converted to WAD as `floor(amount × 1e18)`.
   * @param assetType - Target pool (default XLM); undeployed pools return an
   *                    error rather than throwing.
   * @returns `{ success, hash?, error? }`.
   */
  static async withdraw(
    walletAddress: string, 
    amount: number, 
    assetType: AssetType = ASSET_TYPES.XLM
  ): Promise<{ success: boolean; hash?: string; error?: string }> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(walletAddress);
      
      let contractAddress: string;
      let methodName: string;
      
      switch (assetType) {
        case ASSET_TYPES.XLM:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_XLM;
          break;
        case ASSET_TYPES.USDC:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_USDC;
          break;
        case ASSET_TYPES.BLEND_USDC:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_BLEND_USDC;
          break;
        case ASSET_TYPES.AQUARIUS_USDC:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_AQUARIUS_USDC;
          break;
        case ASSET_TYPES.SOROSWAP_USDC:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_SOROSWAP_USDC;
          break;
        default:
          throw new Error('Unsupported asset type');
      }
      methodName = 'redeem_vtokens';
      
      const contract = new StellarSdk.Contract(contractAddress);
      
      const amountWAD = (BigInt(Math.floor(amount * 1e18))).toString();
      
      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            methodName,
            StellarSdk.nativeToScVal(walletAddress, { type: 'address' }),
            StellarSdk.nativeToScVal(amountWAD, { type: 'u256' })
          )
        )
        .setTimeout(30)
        .build();

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
        await ContractService.pollTransactionStatus(server, result.hash);
        return { success: true, hash: result.hash };
      } else {
        throw new Error('Transaction rejected by network');
      }
    } catch (error: any) {
      console.error('Withdraw error:', error);
      return { success: false, error: error?.message || 'Withdraw failed' };
    }
  }

  /**
   * Read a holder's vToken (deposit-receipt) balance for a pool via simulation,
   * scaled by the vToken's own decimals.
   *
   * @param address - Holder G-address; also the simulation source.
   * @param assetType - Which pool's vToken to read (default XLM).
   * @returns Balance fixed to 7 decimals, `'0'` when empty/undeployed/sim-fail,
   *          or `'Error'` on exception.
   */
  static async getDepositedBalance(
    address: string,
    assetType: AssetType = ASSET_TYPES.XLM
  ): Promise<string> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(address);
      
      let contractAddress: string;
      
      switch (assetType) {
        case ASSET_TYPES.XLM:
          contractAddress = CONTRACT_ADDRESSES.VXLM_TOKEN;
          break;
        case ASSET_TYPES.USDC:
          contractAddress = CONTRACT_ADDRESSES.VUSDC_TOKEN;
          break;
        case ASSET_TYPES.BLEND_USDC:
          contractAddress = CONTRACT_ADDRESSES.VBLEND_USDC_TOKEN;
          break;
        case ASSET_TYPES.AQUARIUS_USDC:
          contractAddress = CONTRACT_ADDRESSES.VAQUARIUS_USDC_TOKEN;
          break;
        case ASSET_TYPES.SOROSWAP_USDC:
          contractAddress = CONTRACT_ADDRESSES.VSOROSWAP_USDC_TOKEN;
          break;
        default:
          throw new Error('Unsupported asset type');
      }

      const contract = new StellarSdk.Contract(contractAddress);

      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            'balance',
            StellarSdk.nativeToScVal(address, { type: 'address' })
          )
        )
        .setTimeout(30)
        .build();

      const simulationResponse = await server.simulateTransaction(transaction);
      
      if (StellarSdk.rpc.Api.isSimulationSuccess(simulationResponse)) {
        const result = simulationResponse.result;
        if (result && result.retval) {
          const balance = StellarSdk.scValToNative(result.retval);
          const decimals = await this.getTokenDecimals(contractAddress);
          const balanceDecimal = Number(balance) / 10 ** decimals;
          return balanceDecimal.toFixed(7);
        } else {
          return '0';
        }
      } else {
        console.error(`[getDepositedBalance] Simulation failed for ${assetType}`);
        return '0';
      }
    } catch (error: any) {
      console.error(`[getDepositedBalance] Error fetching deposited balance for ${assetType}:`, error);
      return 'Error';
    }
  }

  /**
   * Poll a submitted transaction until it leaves NOT_FOUND, retrying every 2s up
   * to 30 times (~60s). Soroban submission is async, so this is how callers wait
   * for finality after `sendTransaction`.
   *
   * @param server - Soroban RPC server to poll.
   * @param hash - Transaction hash returned by `sendTransaction`.
   * @returns Resolves once the tx is SUCCESS.
   * @throws If the tx reports a failed status, or if it never resolves within
   *         the attempt budget ("Transaction timeout").
   */
  static async pollTransactionStatus(server: StellarSdk.rpc.Server, hash: string): Promise<void> {
    let attempts = 0;
    const maxAttempts = 30;

    while (attempts < maxAttempts) {
      try {
        const transaction = await server.getTransaction(hash);
        if (transaction.status !== 'NOT_FOUND') {
          if (transaction.status === 'SUCCESS') {
            return;
          } else {
            throw new Error('Transaction failed');
          }
        }
      } catch (error: any) {
        if (error?.message?.includes('Transaction failed')) {
          throw error;
        }
        // Continue polling
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
      attempts++;
    }
    
    throw new Error('Transaction timeout');
  }

  /**
   * Read a pool's available (un-borrowed) liquidity via
   * `get_total_liquidity_in_pool`, converting the returned WAD to a decimal.
   * Simulated from a throwaway random source account (no signer needed).
   *
   * @param assetType - Pool to query (default XLM).
   * @returns Liquidity fixed to 7 decimals; `'0'` when undeployed or on error.
   */
  static async getPoolLiquidity(assetType: AssetType = ASSET_TYPES.XLM): Promise<string> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      
      let contractAddress: string;
      switch (assetType) {
        case ASSET_TYPES.XLM:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_XLM;
          break;
        case ASSET_TYPES.USDC:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_USDC;
          break;
        case ASSET_TYPES.BLEND_USDC:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_BLEND_USDC;
          break;
        case ASSET_TYPES.AQUARIUS_USDC:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_AQUARIUS_USDC;
          break;
        case ASSET_TYPES.SOROSWAP_USDC:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_SOROSWAP_USDC;
          break;
        default:
          throw new Error('Unsupported asset type');
      }

      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');
      
      const contract = new StellarSdk.Contract(contractAddress);
      
      const transaction = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call('get_total_liquidity_in_pool'))
        .setTimeout(30)
        .build();

      const simulationResponse = await server.simulateTransaction(transaction);
      
      if (StellarSdk.rpc.Api.isSimulationSuccess(simulationResponse)) {
        const result = simulationResponse.result;
        if (result && result.retval) {
          const liquidityWad = StellarSdk.scValToNative(result.retval);
          // Convert from WAD (18 decimals) to regular decimal
          const liquidity = Number(liquidityWad) / 1e18;
          return liquidity.toFixed(7);
        }
      }
      return '0';
    } catch (error: any) {
      console.error('Error fetching pool liquidity:', error);
      return '0';
    }
  }

  /**
   * Read a pool's total outstanding borrows via `get_borrows` (WAD → decimal).
   * Simulated from a throwaway random source account.
   *
   * @param assetType - Pool to query (default XLM).
   * @returns Borrows fixed to 7 decimals; `'0'` when undeployed or on error.
   */
  static async getPoolBorrows(assetType: AssetType = ASSET_TYPES.XLM): Promise<string> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      
      let contractAddress: string;
      switch (assetType) {
        case ASSET_TYPES.XLM:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_XLM;
          break;
        case ASSET_TYPES.USDC:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_USDC;
          break;
        case ASSET_TYPES.BLEND_USDC:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_BLEND_USDC;
          break;
        case ASSET_TYPES.AQUARIUS_USDC:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_AQUARIUS_USDC;
          break;
        case ASSET_TYPES.SOROSWAP_USDC:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_SOROSWAP_USDC;
          break;
        default:
          throw new Error('Unsupported asset type');
      }

      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');

      const contract = new StellarSdk.Contract(contractAddress);

      const transaction = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call('get_borrows'))
        .setTimeout(30)
        .build();

      const simulationResponse = await server.simulateTransaction(transaction);
      
      if (StellarSdk.rpc.Api.isSimulationSuccess(simulationResponse)) {
        const result = simulationResponse.result;
        if (result && result.retval) {
          const borrowsWad = StellarSdk.scValToNative(result.retval);
          const borrows = Number(borrowsWad) / 1e18;
          return borrows.toFixed(7);
        }
      }
      return '0';
    } catch (error: any) {
      console.error('Error fetching pool borrows:', error);
      return '0';
    }
  }

  /**
   * Read a pool's total managed assets (liquidity + borrows) via `total_assets`
   * (WAD → decimal). Simulated from a throwaway random source account.
   *
   * @param assetType - Pool to query (default XLM).
   * @returns Total assets fixed to 7 decimals; `'0'` when undeployed or on error.
   */
  static async getTotalAssets(assetType: AssetType = ASSET_TYPES.XLM): Promise<string> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      
      let contractAddress: string;
      switch (assetType) {
        case ASSET_TYPES.XLM:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_XLM;
          break;
        case ASSET_TYPES.USDC:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_USDC;
          break;
        case ASSET_TYPES.BLEND_USDC:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_BLEND_USDC;
          break;
        case ASSET_TYPES.AQUARIUS_USDC:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_AQUARIUS_USDC;
          break;
        case ASSET_TYPES.SOROSWAP_USDC:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_SOROSWAP_USDC;
          break;
        default:
          throw new Error('Unsupported asset type');
      }

      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');

      const contract = new StellarSdk.Contract(contractAddress);

      const transaction = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call('total_assets'))
        .setTimeout(30)
        .build();

      const simulationResponse = await server.simulateTransaction(transaction);
      
      if (StellarSdk.rpc.Api.isSimulationSuccess(simulationResponse)) {
        const result = simulationResponse.result;
        if (result && result.retval) {
          const totalWad = StellarSdk.scValToNative(result.retval);
          const total = Number(totalWad) / 1e18;
          return total.toFixed(7);
        }
      }
      return '0';
    } catch (error: any) {
      console.error('Error fetching total assets:', error);
      return '0';
    }
  }

  /**
   * Read a pool vToken's `total_supply`, scaled by the vToken's decimals.
   * Simulated from a throwaway random source account.
   *
   * @param assetType - Pool whose vToken to query (default XLM).
   * @returns Supply fixed to 7 decimals; `'0'` when undeployed or on error.
   */
  static async getVTokenTotalSupply(assetType: AssetType = ASSET_TYPES.XLM): Promise<string> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      
      let contractAddress: string;
      switch (assetType) {
        case ASSET_TYPES.XLM:
          contractAddress = CONTRACT_ADDRESSES.VXLM_TOKEN;
          break;
        case ASSET_TYPES.USDC:
          contractAddress = CONTRACT_ADDRESSES.VUSDC_TOKEN;
          break;
        case ASSET_TYPES.BLEND_USDC:
          contractAddress = CONTRACT_ADDRESSES.VBLEND_USDC_TOKEN;
          break;
        case ASSET_TYPES.AQUARIUS_USDC:
          contractAddress = CONTRACT_ADDRESSES.VAQUARIUS_USDC_TOKEN;
          break;
        case ASSET_TYPES.SOROSWAP_USDC:
          contractAddress = CONTRACT_ADDRESSES.VSOROSWAP_USDC_TOKEN;
          break;
        default:
          throw new Error('Unsupported asset type');
      }

      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');

      const contract = new StellarSdk.Contract(contractAddress);

      const transaction = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call('total_supply'))
        .setTimeout(30)
        .build();

      const simulationResponse = await server.simulateTransaction(transaction);
      
      if (StellarSdk.rpc.Api.isSimulationSuccess(simulationResponse)) {
        const result = simulationResponse.result;
        if (result && result.retval) {
          const supply = StellarSdk.scValToNative(result.retval);
          const decimals = await this.getTokenDecimals(contractAddress);
          const supplyDecimal = Number(supply) / 10 ** decimals;
          return supplyDecimal.toFixed(7);
        }
      }
      return '0';
    } catch (error: any) {
      console.error('Error fetching vToken supply:', error);
      return '0';
    }
  }

  /**
   * Aggregate a pool's headline stats in one call, fetching liquidity, borrows
   * and vToken supply in parallel. `totalSupply` is liquidity + borrows;
   * `utilizationRate` is borrows / totalSupply as a percentage string.
   *
   * @param assetType - Pool to summarize (default XLM).
   * @returns `{ totalSupply, totalBorrowed, availableLiquidity, utilizationRate,
   *          vTokenSupply }` — all stringified; an all-zero object on error.
   */
  static async getPoolStats(assetType: AssetType = ASSET_TYPES.XLM): Promise<{
    totalSupply: string;
    totalBorrowed: string;
    availableLiquidity: string;
    utilizationRate: string;
    vTokenSupply: string;
  }> {
    try {
      const [liquidity, borrows, vTokenSupply] = await Promise.all([
        this.getPoolLiquidity(assetType),
        this.getPoolBorrows(assetType),
        this.getVTokenTotalSupply(assetType),
      ]);
      
      const liquidityNum = parseFloat(liquidity) || 0;
      const borrowsNum = parseFloat(borrows) || 0;
      const totalSupply = liquidityNum + borrowsNum;
      
      // Calculate utilization rate
      const utilizationRate = totalSupply > 0 
        ? ((borrowsNum / totalSupply) * 100).toFixed(2)
        : '0';
      
      return {
        totalSupply: totalSupply.toFixed(7),
        totalBorrowed: borrows,
        availableLiquidity: liquidity,
        utilizationRate,
        vTokenSupply,
      };
    } catch (error: any) {
      console.error('Error fetching pool stats:', error);
      return {
        totalSupply: '0',
        totalBorrowed: '0',
        availableLiquidity: '0',
        utilizationRate: '0',
        vTokenSupply: '0',
      };
    }
  }

  /**
   * Read a user's outstanding borrow balance for a pool via
   * `get_borrow_balance` (WAD ÷ 1e18). Simulated from the user's own account.
   *
   * @param address - Borrower G-address; also the simulation source.
   * @param assetType - Pool to query (default XLM).
   * @returns Borrow balance fixed to 7 decimals; `'0'` when undeployed or on error.
   */
  static async getUserBorrowBalance(
    address: string,
    assetType: AssetType = ASSET_TYPES.XLM
  ): Promise<string> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(address);
      
      let contractAddress: string;
      switch (assetType) {
        case ASSET_TYPES.XLM:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_XLM;
          break;
        case ASSET_TYPES.USDC:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_USDC;
          break;
        case ASSET_TYPES.BLEND_USDC:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_BLEND_USDC;
          break;
        case ASSET_TYPES.AQUARIUS_USDC:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_AQUARIUS_USDC;
          break;
        case ASSET_TYPES.SOROSWAP_USDC:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_SOROSWAP_USDC;
          break;
        default:
          throw new Error('Unsupported asset type');
      }

      const contract = new StellarSdk.Contract(contractAddress);

      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            'get_borrow_balance',
            StellarSdk.nativeToScVal(address, { type: 'address' })
          )
        )
        .setTimeout(30)
        .build();

      const simulationResponse = await server.simulateTransaction(transaction);
      
      if (StellarSdk.rpc.Api.isSimulationSuccess(simulationResponse)) {
        const result = simulationResponse.result;
        if (result && result.retval) {
          const balance = StellarSdk.scValToNative(result.retval);
          const balanceDecimal = Number(balance) / 1e18;
          return balanceDecimal.toFixed(7);
        }
      }
      return '0';
    } catch (error: any) {
      console.error('Error fetching borrow balance:', error);
      return '0';
    }
  }

  /**
   * Read a wallet's spendable balances for every supported asset.
   *
   * Native XLM comes from Horizon; the USDC variants are read directly from
   * their Soroban SAC contracts rather than Horizon trustlines — collateral
   * transfers move SAC tokens, so showing the contract balance avoids
   * false-positive "available" amounts from a trustline that isn't the real
   * source. `USDC` and `BLEND_USDC` intentionally mirror the same Blend balance.
   *
   * @param address - Wallet G-address to query.
   * @returns Per-asset balances fixed to 7 decimals. On a transient
   *          Horizon/RPC failure it warns (not errors) and returns all zeros,
   *          since the next refresh typically recovers.
   */
  static async getAllTokenBalances(address: string): Promise<{
    XLM: string;
    USDC: string;
    BLEND_USDC: string;
    AQUARIUS_USDC: string;
    SOROSWAP_USDC: string;
  }> {
    try {
      const server = new StellarSdk.Horizon.Server(HORIZON_URL);
      const account = await server.loadAccount(address);
      
      let xlmBalance = '0';
      
      for (const balance of account.balances) {
        if (balance.asset_type === 'native') {
          xlmBalance = parseFloat(balance.balance).toFixed(7);
        }
      }

      // Read protocol-specific USDC balances directly from Soroban token contracts
      // to avoid issuer/trustline source mismatches in UI.
      const [blendUsdcContractBalance, aquariusUsdcContractBalance, soroswapUsdcBalance] = await Promise.all([
        ContractService.getSorobanTokenWalletBalance(CONTRACT_ADDRESSES.BLEND_USDC, address),
        ContractService.getSorobanTokenWalletBalance(CONTRACT_ADDRESSES.AQUARIUS_USDC, address),
        ContractService.getSorobanTokenWalletBalance(CONTRACT_ADDRESSES.SOROSWAP_USDC, address),
      ]);

      // Collateral transfers use Soroban token contracts, so show contract balances
      // directly to avoid false-positive "available" amounts from Horizon trustlines.
      const blendUsdc = (parseFloat(blendUsdcContractBalance) || 0).toFixed(7);
      const aquariusUsdc = (parseFloat(aquariusUsdcContractBalance) || 0).toFixed(7);
      
      return {
        XLM: xlmBalance,
        USDC: blendUsdc,
        BLEND_USDC: blendUsdc,
        AQUARIUS_USDC: aquariusUsdc,
        SOROSWAP_USDC: soroswapUsdcBalance,
      };
    } catch (error: any) {
      // Transient Horizon/RPC failure (testnet rate-limit or brief outage). Handled
      // with a zero fallback — warn, not error, so the dev overlay doesn't flag a
      // recoverable network blip the next ledger tick / refresh will fix.
      console.warn('Error fetching token balances (using zero fallback):', error?.message ?? error);
      return {
        XLM: '0',
        USDC: '0',
        BLEND_USDC: '0',
        AQUARIUS_USDC: '0',
        SOROSWAP_USDC: '0',
      };
    }
  }
}
