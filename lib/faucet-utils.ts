/**
 * Testnet faucets are disabled on mainnet.
 * Users must fund wallets with real XLM / Circle USDC.
 */

export type FaucetTokenId = 'XLM' | 'USDC';

export interface FaucetResult {
  ok: boolean;
  hash?: string;
  alreadyFunded?: boolean;
  error?: string;
}

const MAINNET_DISABLED: FaucetResult = {
  ok: false,
  error:
    'Faucets are not available on mainnet. Fund your wallet with XLM and Circle USDC, then retry.',
};

export const fundXlmViaFriendbot = async (_address: string): Promise<FaucetResult> =>
  MAINNET_DISABLED;

export const fundBlendUsdc = async (_address: string): Promise<FaucetResult> => MAINNET_DISABLED;

export const fundAquariusUsdc = async (_address: string): Promise<FaucetResult> =>
  MAINNET_DISABLED;

export const fundSoroswapUsdc = async (_address: string): Promise<FaucetResult> =>
  MAINNET_DISABLED;

export const fundToken = async (
  _tokenId: FaucetTokenId | string,
  _address: string,
): Promise<FaucetResult> => MAINNET_DISABLED;
