/**
 * AccountManager.exec helpers for mainnet Protocol_V1_Soroban.
 *
 * Replaces legacy AccountManager.execute(smart_account, ExternalProtocolCall bytes)
 * with typed:
 *   exec(smart_account, target, action, tokens: Vec<Address>, amounts_wad: Vec<u128>, min_out)
 */

import * as StellarSdk from '@stellar/stellar-sdk';
import { signTransaction } from '@/lib/wallet-adapter';
import {
  CONTRACT_ADDRESSES,
  NETWORK_PASSPHRASE,
  SOROBAN_RPC_URL,
} from './stellar-utils';

export type ExternalAction =
  | 'Supply'
  | 'Withdraw'
  | 'Swap'
  | 'AddLiquidity'
  | 'RemoveLiquidity'
  | 'PlaceOrder';

export type ExecResult = {
  success: boolean;
  hash?: string;
  error?: string;
};

/** Soroban unit-variant encoding: Vec([Symbol(action)]). */
export function externalActionScVal(action: ExternalAction): StellarSdk.xdr.ScVal {
  return StellarSdk.xdr.ScVal.scvVec([StellarSdk.xdr.ScVal.scvSymbol(action)]);
}

/** Build ScVal args for AccountManager.exec(...). */
export function buildExecArgs(
  smartAccount: string,
  target: string,
  action: ExternalAction,
  tokenAddresses: string[],
  amountsWad: bigint[],
  minOut: bigint,
): StellarSdk.xdr.ScVal[] {
  return [
    StellarSdk.nativeToScVal(smartAccount, { type: 'address' }),
    StellarSdk.nativeToScVal(target, { type: 'address' }),
    externalActionScVal(action),
    StellarSdk.nativeToScVal(tokenAddresses, { type: ['address'] }),
    StellarSdk.xdr.ScVal.scvVec(
      amountsWad.map((a) => StellarSdk.nativeToScVal(a, { type: 'u128' })),
    ),
    StellarSdk.nativeToScVal(minOut, { type: 'u128' }),
  ];
}

async function pollTransactionStatus(
  server: StellarSdk.rpc.Server,
  hash: string,
): Promise<void> {
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const tx = await server.getTransaction(hash);
      if (tx.status !== 'NOT_FOUND') {
        if (tx.status === 'SUCCESS') return;
        throw new Error(`Transaction failed with status: ${tx.status}`);
      }
    } catch (error: any) {
      if (error?.message?.includes('Transaction failed')) throw error;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('Transaction timed out waiting for confirmation');
}

/**
 * Call AccountManager.exec via Freighter-signed wallet tx.
 * @param feeMultiplier - Multiplier on BASE_FEE (default 20).
 */
export async function execViaAccountManager(
  walletAddress: string,
  smartAccount: string,
  target: string,
  action: ExternalAction,
  tokenAddresses: string[],
  amountsWad: bigint[],
  minOut: bigint = BigInt(0),
  feeMultiplier = 20,
): Promise<ExecResult> {
  try {
    if (!CONTRACT_ADDRESSES.ACCOUNT_MANAGER) {
      return { success: false, error: 'AccountManager is not configured (CONTRACT_ADDRESSES.ACCOUNT_MANAGER empty)' };
    }

    const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
    const sourceAccount = await server.getAccount(walletAddress);
    const contract = new StellarSdk.Contract(CONTRACT_ADDRESSES.ACCOUNT_MANAGER);
    const args = buildExecArgs(smartAccount, target, action, tokenAddresses, amountsWad, minOut);

    const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: (parseInt(StellarSdk.BASE_FEE) * feeMultiplier).toString(),
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call('exec', ...args))
      .setTimeout(30)
      .build();

    const preparedTx = await server.prepareTransaction(transaction);
    const signResult = await signTransaction(preparedTx.toXDR(), {
      networkPassphrase: NETWORK_PASSPHRASE,
    });
    const signedTx = StellarSdk.TransactionBuilder.fromXDR(
      signResult.signedTxXdr,
      NETWORK_PASSPHRASE,
    );
    const result = await server.sendTransaction(signedTx as StellarSdk.Transaction);

    if (result.status === 'PENDING') {
      await pollTransactionStatus(server, result.hash);
      return { success: true, hash: result.hash };
    }
    return { success: false, error: `Network rejected (status: ${result.status})` };
  } catch (error: any) {
    console.error('[execViaAccountManager] error:', error);
    return { success: false, error: error?.message || 'exec failed' };
  }
}
