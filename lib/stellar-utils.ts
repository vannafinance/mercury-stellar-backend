import { requestAccess, getAddress, signTransaction } from '@stellar/freighter-api';
import * as StellarSdk from '@stellar/stellar-sdk';

// Soroban Network Constants
export const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015'; // Testnet
export const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
export const HORIZON_URL = 'https://horizon-testnet.stellar.org';

// Contract Addresses (deployed to Stellar testnet)
// Freshly redeployed on 2026-04-28 by vanna_deployer: GAUVY7FNDKVWRMW3SYEMX6QMFSWQDKC6XIPJJKAMOEMLZPAI7XZPDV3D
export const CONTRACT_ADDRESSES = {
  // Core Infrastructure
  REGISTRY: 'CC35XWCH7SCQROTNW7PA6HZKP4JMNSVV2K7CX3HY2PSI2MI2ZQQH73ID',
  ORACLE: 'CB72D6SOUHUTCESXYOQOBMP6MRSH47NBYIBH73BBRH3ZRT53LPTB6R7V',
  RATE_MODEL: 'CCJAUPCU6EIFQK6GTAAYLW3Y4YETJAAUPAGBPFGQ2OUJPSW3WWHUCL2Z',
  RISK_ENGINE: 'CDPHBVIRQ2SEFMKPUM4ZOGPERBKPY3NRDJ2XK3JCLN5C63VTBZ22TFFU',

  // Token Contracts (admin = corresponding lending pool, ready for mint/burn)
  VXLM_TOKEN: 'CA43UX5EXSYGO7GALIMAZHFOQJKQREEBSOMQKXFY4Q53W2WT3Q766KCU',
  // USDC-based vTokens for the 4 pools (LENDING_PROTOCOL_USDC === LENDING_PROTOCOL_BLEND_USDC, so they share one vToken)
  VUSDC_TOKEN: 'CALPGNHCBAIVBNFHN4JA7LD5MWP3EUPUKKQYPSVWRTISCN56RUVEOR2S',
  VBLEND_USDC_TOKEN: 'CALPGNHCBAIVBNFHN4JA7LD5MWP3EUPUKKQYPSVWRTISCN56RUVEOR2S',
  VAQUARIUS_USDC_TOKEN: 'CABIJXHKS7APMBX3HAKELEYBJJM5JC2MOTEKBXZ7USMITFSIUQRHQMVF',
  VSOROSWAP_USDC_TOKEN: 'CC3XG2J24HM3FVZ6WGHADCQ2CEXIU3OWBQJMYEVUYGV6G7C5JTSUDKR3',
  VEURC_TOKEN: 'CC7DTPGZP6A47OK4GXSP6MU2MJUVTUDMBREZN3BEAGNBB6XK3UKFJ7YP',

  // Lending Protocols (4 main pools for frontend)
  // Pool 1: XLM
  LENDING_PROTOCOL_XLM: 'CAQWQ652YXHA7YKFQBGW2JQAVS4B4HA7WMUGAYIRZGS2CJ3LQ34XUZBA',
  // Pool 2: BLEND USDC
  LENDING_PROTOCOL_USDC: 'CB6NGO7ZCGWRMAVL7RYYRK2I63MSAWMC5Y3EHT5TMNLBAJPD6FWBNT2E',
  LENDING_PROTOCOL_BLEND_USDC: 'CB6NGO7ZCGWRMAVL7RYYRK2I63MSAWMC5Y3EHT5TMNLBAJPD6FWBNT2E',
  // Pool 3: AQUARIUS USDC
  LENDING_PROTOCOL_AQUARIUS_USDC: 'CDFIKHQUPTEGQO35DWBHH4RLJ62QA6BRDLNBXA2HBRTHY4OD2MJC3EXU',
  // Pool 4: SOROSWAP USDC
  LENDING_PROTOCOL_SOROSWAP_USDC: 'CAHB2PPE5PMJN7R2HAHBVO6C2NMA2BB4JAIQIJSJTIJYGA32QSGLYN6V',
  // Other pools
  LENDING_PROTOCOL_EURC: 'CBAO22UBE7QRVTG3XX6H5TG33YKFM6ZKHIY4IRDD33ADY2WRJBQ4LIAB',
  ACCOUNT_MANAGER: 'CCKJOXCBCCZ54CWNMDXSX3WMMP4AYMJGVBN3HPSJLQA4Z5WCBMA7CSP7',
  SMART_ACCOUNT_TEMPLATE: 'CDD7DEIRLFP36WCU7IHH3ACGBXM7QW3IBTYTRYXM3PV2NFGOKZI3XFWL',
  // Tracks per-margin-account Blend b-token positions (BLEND_XLM, BLEND_USDC)
  TRACKING_TOKEN: 'CBDCPYKNSQYY46PQPXBKLSERJQYG5A6D3MIHUMYPENOFK6NGOZENJEG5',

  // ── Blend Capital Testnet Addresses (https://github.com/blend-capital/blend-utils) ──
  // Single pool contract that handles XLM, USDC, wETH, wBTC supplies/borrows
  BLEND_POOL: 'CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF',       // TestnetV2 pool
  BLEND_BACKSTOP: 'CBDVWXT433PRVTUNM56C3JREF3HIZHRBA64NB2C3B2UNCKIS65ZYCLZA',    // BackstopV2
  BLEND_EMITTER: 'CC3WJVJINN4E3LPMNTWKK7LQZLYDQMZHZA7EZGXATPHHBPKNZRIO3KZ6',    // Emitter
  BLEND_TOKEN: 'CB22KRA3YZVCNCQI64JQ5WE7UY2VAV7WFLK6A2JN3HEX56T2EDAFO7QF',      // BLND token
  // Blend testnet asset contracts (used as reserve assets inside the Blend pool)
  BLEND_XLM: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',        // XLM (matches our registry)
  BLEND_USDC: 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU',       // Blend testnet USDC

  // ── Aquarius AMM Testnet Addresses ──
  // Real router (found from pool's ["Router"] storage key)
  AQUARIUS_ROUTER: 'CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD',
  // XLM/USDC pool (TokenA=CAZRY5 Aquarius USDC, TokenB=CDLZFC XLM)
  AQUARIUS_XLM_USDC_POOL: 'CD3LFMMLBQ6RBJUD3Z2LFDFE6544WDRMWHEZYPI5YDVESYRSO2TT32BX',
  // Aquarius USDC token contract (issuer GAHPYWLK6...)
  AQUARIUS_USDC: 'CAZRY5GSFBFXD7H6GAFBA5YGYQTDXU4QKWKMYFWBAZFUCURN3WKX6LF5',
  // Pool index (BytesN<32>) for the XLM/USDC pool — found via router.get_pools()
  AQUARIUS_POOL_INDEX_HEX: '9ac7a9cde23ac2ada11105eeaa42e43c2ea8332ca0aa8f41f58d7160274d718e',
  // XLM/AQUA pool
  AQUARIUS_XLM_AQUA_POOL: 'CCSXYUVLYALKJGIIYMGYLZI447VS6TDWFTVDL43B4IKK2WERHLWUVCRC',
  // XLM/USDT pool
  AQUARIUS_XLM_USDT_POOL: 'CA6DAGOMK5D7GKBNWVCIEAYSTPJXLQUFWFKSZOMNEM6BVOTUBDCTIT5I',

  // ── Soroswap DEX Testnet Addresses ──
  // Router (https://github.com/soroswap/core/blob/main/public/testnet.contracts.json)
  SOROSWAP_ROUTER: 'CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD',
  // Factory
  SOROSWAP_FACTORY: 'CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY',
  // XLM Soroban token on testnet (same as BLEND_XLM)
  SOROSWAP_XLM: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  // USDC token used by SoUSDC pool on this deployment
  SOROSWAP_USDC: 'CB3TLW74NBIOT3BUWOZ3TUM6RFDF6A4GVIRUQRQZABG5KPOUL4JJOV2F',
  // Deployed Soroswap XLM/USDC pair (LP token contract)
  SOROSWAP_XLM_USDC_POOL: 'CDVAIOYHCD4RUSLQNVFI7RIZBFT2JZMJWM4RTOLQZQXL4QAVXU5RFKDB',
} as const;

// Asset Types
export const ASSET_TYPES = {
  XLM: 'XLM',
  USDC: 'USDC',
  BLEND_USDC: 'BLEND_USDC',
  AQUARIUS_USDC: 'AQUARIUS_USDC',
  SOROSWAP_USDC: 'SOROSWAP_USDC',
} as const;

// Asset Issuers (Stellar Testnet)
export const ASSET_ISSUERS = {
  USDC: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  USDC_AQUARIUS: 'GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER',
  AQUA: 'GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA',
} as const;

export type AssetType = typeof ASSET_TYPES[keyof typeof ASSET_TYPES];

// Wallet connection utilities
export class WalletService {
  static async connectWallet(): Promise<{ address: string; success: boolean; error?: string }> {
    try {
      const accessGranted = await requestAccess();
      if (!accessGranted) {
        return { address: '', success: false, error: 'Please approve the connection in Freighter' };
      }
      
      const result = await getAddress();
      if (result.error) {
        return { address: '', success: false, error: result.error };
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

// Contract interaction utilities
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

  private static async getSorobanTokenWalletBalance(tokenContract: string, walletAddress: string): Promise<string> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(walletAddress);
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
      
      // Select appropriate contract and method based on asset type
      switch (assetType) {
        case ASSET_TYPES.XLM:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_XLM;
          methodName = 'deposit_xlm';
          break;
        case ASSET_TYPES.USDC:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_USDC;
          methodName = 'deposit_usdc';
          break;
        case ASSET_TYPES.BLEND_USDC:
          if (!CONTRACT_ADDRESSES.LENDING_PROTOCOL_BLEND_USDC) {
            return { success: false, error: 'BLEND USDC lending pool not yet deployed' };
          }
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_BLEND_USDC;
          methodName = 'deposit_usdc';
          break;
        case ASSET_TYPES.AQUARIUS_USDC:
          if (!CONTRACT_ADDRESSES.LENDING_PROTOCOL_AQUARIUS_USDC) {
            return { success: false, error: 'AqUSDC lending pool not yet deployed' };
          }
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_AQUARIUS_USDC;
          methodName = 'deposit_usdc';
          break;
        case ASSET_TYPES.SOROSWAP_USDC:
          if (!CONTRACT_ADDRESSES.LENDING_PROTOCOL_SOROSWAP_USDC) {
            return { success: false, error: 'Soroswap USDC lending pool not yet deployed' };
          }
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_SOROSWAP_USDC;
          methodName = 'deposit_usdc';
          break;
        default:
          throw new Error('Unsupported asset type');
      }

      const contract = new StellarSdk.Contract(contractAddress);

      // Convert amount to appropriate format (WAD - 18 decimals)
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

      console.log('Preparing transaction with required authorizations...');
      const preparedTx = await server.prepareTransaction(transaction);

      const operation = preparedTx.operations[0] as StellarSdk.Operation.InvokeHostFunction;
      console.log('Transaction prepared. Auth entries count:', operation?.auth?.length || 0);

      const signResult = await signTransaction(preparedTx.toXDR(), {
        networkPassphrase: NETWORK_PASSPHRASE,
      });

      const signedTx = StellarSdk.TransactionBuilder.fromXDR(
        signResult.signedTxXdr,
        NETWORK_PASSPHRASE
      );

      console.log('Sending transaction...');
      const result = await server.sendTransaction(signedTx as StellarSdk.Transaction);

      if (result.status === 'PENDING') {
        console.log('Transaction pending, polling for status...');
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
      
      // Select appropriate contract and method based on asset type
      switch (assetType) {
        case ASSET_TYPES.XLM:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_XLM;
          methodName = 'redeem_vxlm';
          break;
        case ASSET_TYPES.USDC:
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_USDC;
          methodName = 'redeem_vusdc';
          break;
        case ASSET_TYPES.BLEND_USDC:
          if (!CONTRACT_ADDRESSES.LENDING_PROTOCOL_BLEND_USDC) {
            return { success: false, error: 'BLEND USDC lending pool not yet deployed' };
          }
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_BLEND_USDC;
          methodName = 'redeem_vusdc';
          break;
        case ASSET_TYPES.AQUARIUS_USDC:
          if (!CONTRACT_ADDRESSES.LENDING_PROTOCOL_AQUARIUS_USDC) {
            return { success: false, error: 'AqUSDC lending pool not yet deployed' };
          }
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_AQUARIUS_USDC;
          methodName = 'redeem_vusdc';
          break;
        case ASSET_TYPES.SOROSWAP_USDC:
          if (!CONTRACT_ADDRESSES.LENDING_PROTOCOL_SOROSWAP_USDC) {
            return { success: false, error: 'Soroswap USDC lending pool not yet deployed' };
          }
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_SOROSWAP_USDC;
          methodName = 'redeem_vusdc';
          break;
        default:
          throw new Error('Unsupported asset type');
      }
      
      const contract = new StellarSdk.Contract(contractAddress);
      
      // Convert amount to appropriate format (WAD - 18 decimals)
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

  static async getDepositedBalance(
    address: string,
    assetType: AssetType = ASSET_TYPES.XLM
  ): Promise<string> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(address);
      
      let contractAddress: string;
      
      // Select appropriate vToken contract based on asset type
      switch (assetType) {
        case ASSET_TYPES.XLM:
          contractAddress = CONTRACT_ADDRESSES.VXLM_TOKEN;
          break;
        case ASSET_TYPES.USDC:
          contractAddress = CONTRACT_ADDRESSES.VUSDC_TOKEN;
          break;
        case ASSET_TYPES.BLEND_USDC:
          if (!CONTRACT_ADDRESSES.VBLEND_USDC_TOKEN) return '0';
          contractAddress = CONTRACT_ADDRESSES.VBLEND_USDC_TOKEN;
          break;
        case ASSET_TYPES.AQUARIUS_USDC:
          if (!CONTRACT_ADDRESSES.VAQUARIUS_USDC_TOKEN) return '0';
          contractAddress = CONTRACT_ADDRESSES.VAQUARIUS_USDC_TOKEN;
          break;
        case ASSET_TYPES.SOROSWAP_USDC:
          if (!CONTRACT_ADDRESSES.VSOROSWAP_USDC_TOKEN) return '0';
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

  // Get total liquidity in pool
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
          if (!CONTRACT_ADDRESSES.LENDING_PROTOCOL_BLEND_USDC) return '0';
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_BLEND_USDC;
          break;
        case ASSET_TYPES.AQUARIUS_USDC:
          if (!CONTRACT_ADDRESSES.LENDING_PROTOCOL_AQUARIUS_USDC) return '0';
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_AQUARIUS_USDC;
          break;
        case ASSET_TYPES.SOROSWAP_USDC:
          if (!CONTRACT_ADDRESSES.LENDING_PROTOCOL_SOROSWAP_USDC) return '0';
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_SOROSWAP_USDC;
          break;
        default:
          throw new Error('Unsupported asset type');
      }

      // Create a temporary account for simulation
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

  // Get total borrows in pool
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
          if (!CONTRACT_ADDRESSES.LENDING_PROTOCOL_BLEND_USDC) return '0';
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_BLEND_USDC;
          break;
        case ASSET_TYPES.AQUARIUS_USDC:
          if (!CONTRACT_ADDRESSES.LENDING_PROTOCOL_AQUARIUS_USDC) return '0';
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_AQUARIUS_USDC;
          break;
        case ASSET_TYPES.SOROSWAP_USDC:
          if (!CONTRACT_ADDRESSES.LENDING_PROTOCOL_SOROSWAP_USDC) return '0';
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

  // Get total assets (liquidity + borrows)
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
          if (!CONTRACT_ADDRESSES.LENDING_PROTOCOL_BLEND_USDC) return '0';
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_BLEND_USDC;
          break;
        case ASSET_TYPES.AQUARIUS_USDC:
          if (!CONTRACT_ADDRESSES.LENDING_PROTOCOL_AQUARIUS_USDC) return '0';
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_AQUARIUS_USDC;
          break;
        case ASSET_TYPES.SOROSWAP_USDC:
          if (!CONTRACT_ADDRESSES.LENDING_PROTOCOL_SOROSWAP_USDC) return '0';
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

  // Get vToken total supply
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
          if (!CONTRACT_ADDRESSES.VBLEND_USDC_TOKEN) return '0';
          contractAddress = CONTRACT_ADDRESSES.VBLEND_USDC_TOKEN;
          break;
        case ASSET_TYPES.AQUARIUS_USDC:
          if (!CONTRACT_ADDRESSES.VAQUARIUS_USDC_TOKEN) return '0';
          contractAddress = CONTRACT_ADDRESSES.VAQUARIUS_USDC_TOKEN;
          break;
        case ASSET_TYPES.SOROSWAP_USDC:
          if (!CONTRACT_ADDRESSES.VSOROSWAP_USDC_TOKEN) return '0';
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

  // Get complete pool statistics
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

  // Get user borrow balance
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
          if (!CONTRACT_ADDRESSES.LENDING_PROTOCOL_BLEND_USDC) return '0';
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_BLEND_USDC;
          break;
        case ASSET_TYPES.AQUARIUS_USDC:
          if (!CONTRACT_ADDRESSES.LENDING_PROTOCOL_AQUARIUS_USDC) return '0';
          contractAddress = CONTRACT_ADDRESSES.LENDING_PROTOCOL_AQUARIUS_USDC;
          break;
        case ASSET_TYPES.SOROSWAP_USDC:
          if (!CONTRACT_ADDRESSES.LENDING_PROTOCOL_SOROSWAP_USDC) return '0';
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

  static async getEarnPoolEvents(walletAddress: string): Promise<{
    type: 'supply' | 'withdraw';
    asset: string;
    amount: string;
    timestamp: number;
    hash: string;
    status: 'success';
  }[]> {
    const contractToAsset: Record<string, string> = {
      [CONTRACT_ADDRESSES.LENDING_PROTOCOL_XLM]: 'XLM',
      [CONTRACT_ADDRESSES.LENDING_PROTOCOL_USDC]: 'USDC',
      [CONTRACT_ADDRESSES.LENDING_PROTOCOL_AQUARIUS_USDC]: 'AQUARIUS_USDC',
      [CONTRACT_ADDRESSES.LENDING_PROTOCOL_SOROSWAP_USDC]: 'SOROSWAP_USDC',
    };
    const contractIds = Object.keys(contractToAsset);
    const WAD = BigInt('1000000000000000000');

    const wadToHuman = (raw: unknown): number => {
      try {
        const bi = BigInt(raw!.toString());
        return Number(bi / WAD) + Number(bi % WAD) / 1e18;
      } catch {
        return 0;
      }
    };

    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const ledgerResp = await server.getLatestLedger();
      const startLedger = Math.max(1, ledgerResp.sequence - 518400);

      const depositTopic = StellarSdk.xdr.ScVal.scvSymbol('deposit_event').toXDR('base64');
      const withdrawTopic = StellarSdk.xdr.ScVal.scvSymbol('withdraw_event').toXDR('base64');

      const safeGetEvents = async (topic: string) => {
        try {
          const resp = await (server as any).getEvents({
            startLedger,
            filters: [{ type: 'contract', contractIds, topics: [[topic]] }],
            limit: 200,
          });
          if (resp?.error) return [];
          return resp?.events ?? [];
        } catch {
          return [];
        }
      };

      const [depositEvents, withdrawEvents] = await Promise.all([
        safeGetEvents(depositTopic),
        safeGetEvents(withdrawTopic),
      ]);

      const results: {
        type: 'supply' | 'withdraw';
        asset: string;
        amount: string;
        timestamp: number;
        hash: string;
        status: 'success';
      }[] = [];

      const parseEvents = (events: any[], type: 'supply' | 'withdraw') => {
        for (const ev of events ?? []) {
          try {
            const topics = (ev.topic ?? []).map((t: any) => StellarSdk.scValToNative(t));
            const lenderAddress = topics[1] as string;
            if (!lenderAddress || lenderAddress !== walletAddress) continue;

            const data = ev.value ? StellarSdk.scValToNative(ev.value) : null;
            const asset = contractToAsset[(ev as any).contractId] ?? 'XLM';
            const rawAmount = data && typeof data === 'object'
              ? (type === 'supply' ? data.amount : data.vtoken_amount)
              : undefined;

            results.push({
              type,
              asset,
              amount: wadToHuman(rawAmount).toFixed(7),
              timestamp: ev.ledgerClosedAt ? new Date(ev.ledgerClosedAt).getTime() : 0,
              hash: ev.txHash ?? '',
              status: 'success',
            });
          } catch { /* skip malformed events */ }
        }
      };

      parseEvents(depositEvents, 'supply');
      parseEvents(withdrawEvents, 'withdraw');
      results.sort((a, b) => b.timestamp - a.timestamp);
      return results.slice(0, 20);
    } catch (err: any) {
      console.warn('[ContractService] getEarnPoolEvents error:', err?.message ?? err);
      return [];
    }
  }

  // Get all token balances for a wallet (XLM, USDC, AqUSDC, SoUSDC)
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
      console.error('Error fetching token balances:', error);
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
