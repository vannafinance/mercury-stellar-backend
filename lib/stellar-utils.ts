import { requestAccess, getAddress, signTransaction } from '@/lib/wallet-adapter';
import * as StellarSdk from '@stellar/stellar-sdk';

export const NETWORK_PASSPHRASE = 'Public Global Stellar Network ; September 2015';
export const SOROBAN_RPC_URL = 'https://mainnet.sorobanrpc.com';
export const HORIZON_URL = 'https://horizon.stellar.org';

// Mainnet (Protocol_V1_Soroban): one Circle USDC shared by Blend / Aquarius /
// Soroswap, two Vanna lending pools (XLM + USDC). External protocol addresses
// from MAINNET_DEPLOYMENT_COMMANDS.md (verified July 2026).
//
// Vanna contract IDs are left empty until mainnet deploy — fill from
// deploy/mainnet .env after upload. External SAC / DEX / Blend addresses are live.
export const CONTRACT_ADDRESSES = {
  // ── Vanna core (fill after mainnet deploy) ───────────────────────────────
  REGISTRY: '',
  ORACLE: '',
  RATE_MODEL: '',
  RISK_ENGINE: '',
  ACCOUNT_MANAGER: '',
  TRACKING_TOKEN: '',
  CONTROLLER_FACADE: '',
  POOL_DEPLOYER: '',

  BLEND_CONTROLLER: '',
  SOROSWAP_CONTROLLER: '',
  AQUARIUS_CONTROLLER: '',

  // vToken receipts — one per lending pool (XLM + USDC)
  VXLM_TOKEN: '',
  VUSDC_TOKEN: '',

  // Lending pools — XLM + single USDC
  LENDING_PROTOCOL_XLM: '',
  LENDING_PROTOCOL_USDC: '',

  // ── Tokens (official mainnet SACs) ───────────────────────────────────────
  XLM_TOKEN: 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',
  USDC_TOKEN: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',

  // Blend Capital v2 (YieldBlox) — external
  BLEND_POOL: 'CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS',
  BLEND_XLM: 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',
  BLEND_USDC: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',

  // Aquarius AMM — external. constant_product XLM/USDC (not concentrated).
  // Verified via amm-api find-path + on-chain get_reserves (Aug 2026).
  // Docs: https://docs.aqua.network/developers/reference/addresses-and-networks
  AQUARIUS_ROUTER: 'CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK',
  AQUARIUS_XLM_USDC_POOL: 'CA6PUJLBYKZKUEKLZJMKBZLEKP2OTHANDEOWSFF44FTSYLKQPIICCJBE',
  AQUARIUS_USDC: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
  AQUARIUS_POOL_INDEX_HEX: 'b2e02fcfca6c96f8ad5cbd84e7784a777b36d9c96a2459402c4f458462aab7f0',
  AQUARIUS_XLM_USDT_POOL: '',

  // Soroswap DEX — external. Factory get_pair(XLM, Circle USDC) on mainnet.
  // Docs: https://docs.soroswap.finance/smart-contracts/01-protocol-overview/03-technical-reference/deployed-addresses
  SOROSWAP_FACTORY: 'CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2',
  SOROSWAP_ROUTER: 'CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH',
  SOROSWAP_XLM: 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',
  SOROSWAP_USDC: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
  SOROSWAP_XLM_USDC_POOL: 'CAM7DY53G63XA4AJRS24Z6VFYAFSSF76C3RZ45BE5YU3FQS5255OOABP',

  // Reflector oracle feed (external; Vanna Oracle wrapper address is ORACLE above)
  REFLECTOR: 'CAFJZQWSED6YAWZU3GWRTOCNPPCGBN32L7QV43XX5LZLFTK6JLN34DLN',
} as const;

export const ASSET_TYPES = {
  XLM: 'XLM',
  USDC: 'USDC',
} as const;

/** Circle USDC classic-side issuer (trustline / Horizon balance checks). */
export const ASSET_ISSUERS = {
  USDC: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  USDC_AQUARIUS: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
} as const;

export type AssetType = typeof ASSET_TYPES[keyof typeof ASSET_TYPES];

/** Lending-pool contract for an earn asset type. */
export function lendingPoolAddress(assetType: AssetType): string {
  switch (assetType) {
    case ASSET_TYPES.XLM: return CONTRACT_ADDRESSES.LENDING_PROTOCOL_XLM;
    case ASSET_TYPES.USDC: return CONTRACT_ADDRESSES.LENDING_PROTOCOL_USDC;
    default: throw new Error(`Unsupported asset type: ${assetType}`);
  }
}

/** vToken receipt contract for an earn asset type. */
export function vTokenAddress(assetType: AssetType): string {
  switch (assetType) {
    case ASSET_TYPES.XLM: return CONTRACT_ADDRESSES.VXLM_TOKEN;
    case ASSET_TYPES.USDC: return CONTRACT_ADDRESSES.VUSDC_TOKEN;
    default: throw new Error(`Unsupported asset type: ${assetType}`);
  }
}

export class WalletService {
  static async connectWallet(): Promise<{ address: string; success: boolean; error?: string }> {
    try {
      const accessGranted = await requestAccess();
      if (!accessGranted) {
        return { address: '', success: false, error: 'Please approve the connection in Freighter' };
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
      
      const contractAddress = lendingPoolAddress(assetType);
      const methodName = 'deposit';

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
      
      const contractAddress = lendingPoolAddress(assetType);
      const methodName = 'redeem_vtokens';
      
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
      
      const contractAddress = vTokenAddress(assetType);

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
      
      const contractAddress = lendingPoolAddress(assetType);

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
      
      const contractAddress = lendingPoolAddress(assetType);

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
      
      const contractAddress = lendingPoolAddress(assetType);

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
      
      const contractAddress = vTokenAddress(assetType);

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
      
      const contractAddress = lendingPoolAddress(assetType);

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
   * Read a wallet's spendable balances for supported mainnet assets.
   *
   * Native XLM comes from Horizon; Circle USDC is read from its Soroban SAC
   * (collateral transfers move SAC tokens, so contract balance is authoritative).
   *
   * @param address - Wallet G-address to query.
   * @returns Per-asset balances fixed to 7 decimals. On transient Horizon/RPC
   *          failure warns and returns zeros (next refresh usually recovers).
   */
  static async getAllTokenBalances(address: string): Promise<{
    XLM: string;
    USDC: string;
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

      const usdcRaw = await ContractService.getSorobanTokenWalletBalance(
        CONTRACT_ADDRESSES.USDC_TOKEN,
        address,
      );
      const usdc = (parseFloat(usdcRaw) || 0).toFixed(7);

      return {
        XLM: xlmBalance,
        USDC: usdc,
      };
    } catch (error: any) {
      console.warn('Error fetching token balances (using zero fallback):', error?.message ?? error);
      return {
        XLM: '0',
        USDC: '0',
      };
    }
  }
}
