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
  // Upgraded 2026-05-17: gross-assets + Blend b-token borrow check (wasm 2ee294cf…)
  RISK_ENGINE: 'CBL7RCG5H4VIZCNF7BRM2FQFXK7N5KRQKW7ZVEQZJKNXHA6FEU4OXK5I',

  // Token Contracts (admin = corresponding lending pool, ready for mint/burn)
  // Redeployed 2026-06-03: budget optimization — get_borrow_balance no longer calls get_rate_factor
  VXLM_TOKEN: 'CCQAAPNBYF6I7PRM2NZ4NRDYZUVJJANMX3RZ4ZLMQH6Z5WAUL2MHU2RZ',
  VUSDC_TOKEN: 'CDAJHQEJ26EBBGV2UYSR5S5LLA6F3A7KQISLPY5JMOL77RUDBEWG3T6Y',
  VBLEND_USDC_TOKEN: 'CDAJHQEJ26EBBGV2UYSR5S5LLA6F3A7KQISLPY5JMOL77RUDBEWG3T6Y',
  VAQUARIUS_USDC_TOKEN: 'CATGJWK22YGAQX4DH6BXUMQYRZRGOQ6MJNJVZP67WZEE4PHSROU763KN',
  VSOROSWAP_USDC_TOKEN: 'CDW5YJOBAR5KUPYQ5LQICSLKWRUMDEGSZVS5A4QNBMNKEZEARR6EJFYT',

  // Lending Protocols (4 main pools for frontend)
  // Redeployed 2026-06-03: budget optimization — get_borrow_balance no longer calls get_rate_factor
  // Pool 1: XLM
  LENDING_PROTOCOL_XLM: 'CBA4E4ZMXUKCDTNT7LDKSO3LGNGKHRCE4GUVPSRCAKU3TKAONUY7SVOB',
  // Pool 2: BLEND USDC
  LENDING_PROTOCOL_USDC: 'CABLEI2ZPCWLO2FQRHJJYR7JW75BCCPN2ZIV5BX7CHPXZT4CZVTGUOBU',
  LENDING_PROTOCOL_BLEND_USDC: 'CABLEI2ZPCWLO2FQRHJJYR7JW75BCCPN2ZIV5BX7CHPXZT4CZVTGUOBU',
  // Pool 3: AQUARIUS USDC
  LENDING_PROTOCOL_AQUARIUS_USDC: 'CCRP3OQLKSOAYGDOF4EMPR5VOHM7XHT77XISPIBRYUWKBICM5LSJFON4',
  // Pool 4: SOROSWAP USDC
  LENDING_PROTOCOL_SOROSWAP_USDC: 'CBSKSUD2EBZAGVWBN747MI7CESXFG5LUBJGLP5CXF4BBAWAFQJ7ABJNO',
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

  /**
   * Read the on-chain SAC balance for a holder. The holder can be either a
   * classic G-account or a contract C-account (e.g. a margin smart account) —
   * in the latter case caller must pass `sourceUserAddress` since the SDK's
   * `Account` builder rejects contract addresses as the simulation source.
   */
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

      const operation = preparedTx.operations[0] as StellarSdk.Operation.InvokeHostFunction;

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
