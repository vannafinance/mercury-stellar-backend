import { requestAccess, getAddress, signTransaction } from '@/lib/wallet-adapter';
import * as StellarSdk from '@stellar/stellar-sdk';

export const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
export const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
export const HORIZON_URL = 'https://horizon-testnet.stellar.org';

// Redeployed 2026-07-19 (third redeploy same day) — testnet genuinely has
// THREE separate USDC test tokens (one per DEX's own pre-existing pool,
// none interchangeable), reversing the prior "single canonical USDC"
// collapse. Registry.get_protocol_config() now returns aquarius_usdc/
// soroswap_usdc as their own real addresses alongside the Blend-side `usdc`.
// Each USDC variant has its own genuine lending pool (3 pools total, plus
// XLM = 4). See CONTRACT_COMMAND.md for the full command sequence.
//
// Live-verified this deploy (real testnet transactions): add liquidity to
// all 4 lending pools -> create margin account -> deposit XLM + borrow
// BLUSDC -> deposit XLM + borrow AqUSDC -> deposit XLM + borrow SoUSDC ->
// Blend Supply (exec) -> Soroswap AddLiquidity + RemoveLiquidity (exec),
// all succeeding with real fund movement and TrackingToken mint/burn.
//
// Aquarius AddLiquidity is registered and reachable but currently BLOCKED by
// a real external-protocol limitation: the live Aquarius router's `deposit`
// performs gauge/reward checkpoint accounting that reads a classic-asset
// trustline balance for `user` — a G-account without that trustline gets a
// graceful "trustline missing" error, but a smart-contract `user` has no
// trustline concept at all, so the same check panics unhandled instead.
// This is a protocol-side constraint on this specific gauge-enabled pool,
// not a bug in our Controller — confirmed by testing every plausible
// auth-entry shape (flat siblings, nested-under-router, nested-under-pool)
// and by reproducing the identical trustline-missing failure with a second
// real G-account. Aquarius RemoveLiquidity was never reached because of this.
export const CONTRACT_ADDRESSES = {
  REGISTRY: 'CBBQQULN3XZDWDZG7D6VYD4UQKBGYH22DOFQEISKENCMZTYUPQ5LDXUO',
  ORACLE: 'CAYHPE4U54GDKULPRHYJZNDMBAJDQ3UNQ446KFYMJ5HABBPORERZCRWB',
  RATE_MODEL: 'CBMJ7DD4EUVZWFRPKRPGYK2NADCIGY5OFTPN7PJ7SAOIJI7IQTVHOJT6',
  RISK_ENGINE: 'CCSCBA4WSUMVGA4CWC7QKBZXXEL4TO2YCCFPGHX5SJCYKHQLQUKAVUAY',
  ACCOUNT_MANAGER: 'CAZLR6EHZXQNZJIFNP6F7SIJQC3P64MKHHQNZSSG5BNAEFCYTTGTDZXB',
  TRACKING_TOKEN: 'CC4P2DC4J3DTKNL7CQB42S3JSZNIVVHFJEMHZWTSDR233CT6O2KK7ZK2',
  CONTROLLER_FACADE: 'CB2SEZGDRPS4O56UYQAERQGHM7V6ZDMZZE5AYOGERRGWT5CUGRPVDWEH',
  POOL_DEPLOYER: 'CCURFEEXKVGDAKXAGNG4NHEK2RRSOBOVUZDNHI32DFBAF2HWO57JKLIP',

  // Per-protocol Controllers — resolved by Registry.get_controller_for(target)
  // Redeployed 2026-07-20/21: all three Controllers now have an admin-gated
  // `upgrade()` fn, so future fixes won't need a fresh redeploy + re-register.
  BLEND_CONTROLLER: 'CCZVHCPWY47GRWCE2TB7QPX7Y54BMQUYQTTAQ5LJGNJ3GLGO77VVQUS3',
  SOROSWAP_CONTROLLER: 'CBSUSG7PK2QKYBEA2GPNNTV7QVGKV7DSDUFDB44FFRZYR4L4GB7BKD2M',
  AQUARIUS_CONTROLLER: 'CBVRH2DWBMASALAMPZ5JUCKZHWO6SA2MD4MBXMO644XNCERWBMKHL2WT',

  // vToken receipt contracts, one per lending pool
  VXLM_TOKEN: 'CDGYZSMWOOKM55WEKEQ2HEMM7RS2KRA7MYI2DDYXWV5YHGUVUGQZSOCB',
  VBLEND_USDC_TOKEN: 'CAZWBJQ6V2XASUILI36UVQJ5K2EQXIDVXJZNGZBEONPUVVURKDOP4RX5',
  VAQUARIUS_USDC_TOKEN: 'CAU5GVAGCWLOIAGFHQFEVBJLDHVS2KH4YPRQ34CIDG2T7RDAWWWODKRV',
  VSOROSWAP_USDC_TOKEN: 'CAIMEE4EZ3FUMOBTVV7DKGI2TDACWXUWU6Z2RJ3NMP642TDKQHHOEIWG',
  VBLND_TOKEN: 'CCYODB2RM2JTNFRNXUM376ZJK4VTBR2UTBAUTKYRVPX4SCJLRZX3QJN6',
  VAQUA_TOKEN: 'CB5DTP5GEI57KNUY4TIGXJ5RQH3GNMAEW5QXF7BBMLYNFWVJXCFEYXWM',
  VWETH_TOKEN: 'CDT7PH6GMWXNPMTR5YMJN4YOGKTFC4JSI3WPWZEFSOLU5DHWDFJPI4Z4',
  VEURC_TOKEN: 'CCCWRXZ3NBSTSGQJ7MRKZ74PANH7UD4ZBWDHJNPOB266PXWB3ARS4EW3',
  // Back-compat alias used by earn constants
  VUSDC_TOKEN: 'CAZWBJQ6V2XASUILI36UVQJ5K2EQXIDVXJZNGZBEONPUVVURKDOP4RX5',

  // Lending Pools — XLM + per-USDC-variant + BLND/AQUA/WETH/EURC
  LENDING_PROTOCOL_XLM: 'CB3LCPDMPRTRXJHO7ZB3OORQDL2AV5FTJPPZOPHTZFOMUPMJY55RHYR3',
  LENDING_PROTOCOL_BLEND_USDC: 'CCHSDWJPFMEFNDRSZ55A5MLSTASYHZERLPJIJGTAD7MT24KHVLOU3BTI',
  LENDING_PROTOCOL_AQUARIUS_USDC: 'CDKMMD63RUZNROFZZD64QZNEQ2FR5X62R4FE6E3USJ5VN5KY7QM6F2FD',
  LENDING_PROTOCOL_SOROSWAP_USDC: 'CCZQUQQVZVNZMTG2P6MVAGA7V2DRTCII6IGVEQ5YUCYP7MXA7SMLHETP',
  LENDING_PROTOCOL_BLND: 'CBS3ULN5JQJVGO5NCWUOT6SBXXD257L4CLKL3ORAMBPPU54QBAG5USP4',
  LENDING_PROTOCOL_AQUA: 'CA4M4K2I2UCKJDAG4YJRJRNBSRCKPFLAV7DGXXR72P33ZYU5ZB5BCMRC',
  LENDING_PROTOCOL_WETH: 'CBKU32EVWW2B5WBRJAH3FOS6RGAC23Y4JEHXMB3DW6FXHRXAI3UBRJZJ',
  LENDING_PROTOCOL_EURC: 'CCUPXLYWGLFWWCVKYONTLML53ZKNYWFHU34BMXJOLZBNXLVAKU3X6DAI',
  // Back-compat alias for call sites still keyed on a single "USDC" pool —
  // resolves to Blend's own pool specifically, not a shared canonical one.
  LENDING_PROTOCOL_USDC: 'CCHSDWJPFMEFNDRSZ55A5MLSTASYHZERLPJIJGTAD7MT24KHVLOU3BTI',

  // Three genuinely distinct USDC test tokens — one per DEX's own real pool.
  BLEND_USDC_TOKEN: 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU',
  AQUARIUS_USDC_TOKEN: 'CAZRY5GSFBFXD7H6GAFBA5YGYQTDXU4QKWKMYFWBAZFUCURN3WKX6LF5',
  SOROSWAP_USDC_TOKEN: 'CB3TLW74NBIOT3BUWOZ3TUM6RFDF6A4GVIRUQRQZABG5KPOUL4JJOV2F',
  // Back-compat alias for old single-USDC call sites — resolves to Blend's own token.
  USDC_TOKEN: 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU',
  BLND_TOKEN: 'CB22KRA3YZVCNCQI64JQ5WE7UY2VAV7WFLK6A2JN3HEX56T2EDAFO7QF',
  AQUA_TOKEN: 'CDNVQW44C3HALYNVQ4SOBXY5EWYTGVYXX6JPESOLQDABJI5FC5LTRRUE',
  WETH_TOKEN: 'CAZAQB3D7KSLSNOSQKYD2V4JP5V2Y3B4RDJZRLBFCCIXDCTE3WHSY3UE',
  EURC_TOKEN: 'CBQDUWBOHS7P4TZIJ3KUPUZQOWMKJC6CQPPFEONSV3BH4X27YVEXWNOT',

  // Blend Capital (testnet, external, unchanged)
  BLEND_POOL: 'CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF',
  BLEND_XLM: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  BLEND_USDC: 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU',
  BLEND_WETH: 'CAZAQB3D7KSLSNOSQKYD2V4JP5V2Y3B4RDJZRLBFCCIXDCTE3WHSY3UE',
  // BLND is the Blend reward/governance token SAC; it is NOT a reserve on
  // TestnetV2 pool CCEBVDYM… (get_reserve fails). Earn uses Vanna's own BLND pool.

  // Aquarius AMM (testnet, external). Registered and reachable — see the
  // gauge/trustline limitation noted above for why AddLiquidity still fails.
  // Only constant_product pools are supported (no concentrated).
  AQUARIUS_ROUTER: 'CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD',
  AQUARIUS_XLM_USDC_POOL: 'CD3LFMMLBQ6RBJUD3Z2LFDFE6544WDRMWHEZYPI5YDVESYRSO2TT32BX',
  AQUARIUS_USDC: 'CAZRY5GSFBFXD7H6GAFBA5YGYQTDXU4QKWKMYFWBAZFUCURN3WKX6LF5',
  AQUARIUS_POOL_INDEX_HEX: '9ac7a9cde23ac2ada11105eeaa42e43c2ea8332ca0aa8f41f58d7160274d718e',
  AQUARIUS_XLM_AQUA_POOL: 'CCSXYUVLYALKJGIIYMGYLZI447VS6TDWFTVDL43B4IKK2WERHLWUVCRC',
  AQUARIUS_XLM_USDT_POOL: 'CA6DAGOMK5D7GKBNWVCIEAYSTPJXLQUFWFKSZOMNEM6BVOTUBDCTIT5I',
  AQUARIUS_WETH_AQUA_POOL: 'CC34YQZWLLNLRFSBENB2HTQVYDHOOEVN55TG32AL2Y2OXUY5IR26H55A',
  AQUARIUS_WETH_AQUA_POOL_INDEX_HEX: 'b2e02fcfca6c96f8ad5cbd84e7784a777b36d9c96a2459402c4f458462aab7f0',
  AQUARIUS_AQUA: 'CDNVQW44C3HALYNVQ4SOBXY5EWYTGVYXX6JPESOLQDABJI5FC5LTRRUE',
  AQUARIUS_WETH: 'CAZAQB3D7KSLSNOSQKYD2V4JP5V2Y3B4RDJZRLBFCCIXDCTE3WHSY3UE',

  // Soroswap DEX (testnet, external). XLM/SoUSDC pair auto-created live by
  // the router's own add_liquidity (Soroswap creates pairs on demand).
  SOROSWAP_ROUTER: 'CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD',
  SOROSWAP_XLM: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  SOROSWAP_USDC: 'CB3TLW74NBIOT3BUWOZ3TUM6RFDF6A4GVIRUQRQZABG5KPOUL4JJOV2F',
  SOROSWAP_XLM_USDC_POOL: 'CDVAIOYHCD4RUSLQNVFI7RIZBFT2JZMJWM4RTOLQZQXL4QAVXU5RFKDB',
  SOROSWAP_EURC: 'CBQDUWBOHS7P4TZIJ3KUPUZQOWMKJC6CQPPFEONSV3BH4X27YVEXWNOT',
  SOROSWAP_XLM_EURC_POOL: 'CDRKRVJLWZNKB4W5GCJU27R6LVT2GD2WNYVUPBB2J3MXBEOHMB74WOX5',
} as const;

export const ASSET_TYPES = {
  XLM: 'XLM',
  // Back-compat alias for old single-USDC call sites — resolves to Blend's own pool/token.
  USDC: 'USDC',
  BLEND_USDC: 'BLEND_USDC',
  AQUARIUS_USDC: 'AQUARIUS_USDC',
  SOROSWAP_USDC: 'SOROSWAP_USDC',
  BLND: 'BLND',
  AQUA: 'AQUA',
  WETH: 'WETH',
  EURC: 'EURC',
} as const;

// Aquarius USDC classic-side issuer (for trustline/Horizon balance checks)
export const ASSET_ISSUERS = {
  USDC_AQUARIUS: 'GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER',
  // AQUA is issued by the same account as Aquarius's USDC distribution keypair.
  AQUA: 'GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER',
  // Blend's testnet "wETH" (lowercase w) classic asset — shares an issuer with BLND.
  WETH_BLEND: 'GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56',
} as const;

export type AssetType = typeof ASSET_TYPES[keyof typeof ASSET_TYPES];

/** Lending-pool contract for an earn asset type. */
export function lendingPoolAddress(assetType: AssetType): string {
  switch (assetType) {
    case ASSET_TYPES.XLM: return CONTRACT_ADDRESSES.LENDING_PROTOCOL_XLM;
    case ASSET_TYPES.USDC:
    case ASSET_TYPES.BLEND_USDC: return CONTRACT_ADDRESSES.LENDING_PROTOCOL_BLEND_USDC;
    case ASSET_TYPES.AQUARIUS_USDC: return CONTRACT_ADDRESSES.LENDING_PROTOCOL_AQUARIUS_USDC;
    case ASSET_TYPES.SOROSWAP_USDC: return CONTRACT_ADDRESSES.LENDING_PROTOCOL_SOROSWAP_USDC;
    case ASSET_TYPES.BLND: return CONTRACT_ADDRESSES.LENDING_PROTOCOL_BLND;
    case ASSET_TYPES.AQUA: return CONTRACT_ADDRESSES.LENDING_PROTOCOL_AQUA;
    case ASSET_TYPES.WETH: return CONTRACT_ADDRESSES.LENDING_PROTOCOL_WETH;
    case ASSET_TYPES.EURC: return CONTRACT_ADDRESSES.LENDING_PROTOCOL_EURC;
    default: throw new Error(`Unsupported asset type: ${assetType}`);
  }
}

/** vToken receipt contract for an earn asset type. */
export function vTokenAddress(assetType: AssetType): string {
  switch (assetType) {
    case ASSET_TYPES.XLM: return CONTRACT_ADDRESSES.VXLM_TOKEN;
    case ASSET_TYPES.USDC:
    case ASSET_TYPES.BLEND_USDC: return CONTRACT_ADDRESSES.VBLEND_USDC_TOKEN;
    case ASSET_TYPES.AQUARIUS_USDC: return CONTRACT_ADDRESSES.VAQUARIUS_USDC_TOKEN;
    case ASSET_TYPES.SOROSWAP_USDC: return CONTRACT_ADDRESSES.VSOROSWAP_USDC_TOKEN;
    case ASSET_TYPES.BLND: return CONTRACT_ADDRESSES.VBLND_TOKEN;
    case ASSET_TYPES.AQUA: return CONTRACT_ADDRESSES.VAQUA_TOKEN;
    case ASSET_TYPES.WETH: return CONTRACT_ADDRESSES.VWETH_TOKEN;
    case ASSET_TYPES.EURC: return CONTRACT_ADDRESSES.VEURC_TOKEN;
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
    BLND: string;
    AQUA: string;
    WETH: string;
    EURC: string;
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

      // Read protocol-specific token balances directly from Soroban SAC contracts
      // to avoid issuer/trustline source mismatches in UI.
      const [
        blendUsdcContractBalance,
        aquariusUsdcContractBalance,
        soroswapUsdcBalance,
        blndBalance,
        aquaBalance,
        wethBalance,
        eurcBalance,
      ] = await Promise.all([
        ContractService.getSorobanTokenWalletBalance(CONTRACT_ADDRESSES.BLEND_USDC, address),
        ContractService.getSorobanTokenWalletBalance(CONTRACT_ADDRESSES.AQUARIUS_USDC, address),
        ContractService.getSorobanTokenWalletBalance(CONTRACT_ADDRESSES.SOROSWAP_USDC, address),
        ContractService.getSorobanTokenWalletBalance(CONTRACT_ADDRESSES.BLND_TOKEN, address),
        ContractService.getSorobanTokenWalletBalance(CONTRACT_ADDRESSES.AQUA_TOKEN, address),
        ContractService.getSorobanTokenWalletBalance(CONTRACT_ADDRESSES.WETH_TOKEN, address),
        ContractService.getSorobanTokenWalletBalance(CONTRACT_ADDRESSES.EURC_TOKEN, address),
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
        BLND: blndBalance,
        AQUA: aquaBalance,
        WETH: wethBalance,
        EURC: eurcBalance,
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
        BLND: '0',
        AQUA: '0',
        WETH: '0',
        EURC: '0',
      };
    }
  }
}
