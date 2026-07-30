import { AMOY_CHAIN_HEX, AMOY_CHAIN_ID, AMOY_EXPLORER } from './constants.js';

export const POLYGON_AMOY = Object.freeze({
  chainId: AMOY_CHAIN_ID,
  chainIdHex: AMOY_CHAIN_HEX,
  name: 'Polygon Amoy',
  nativeCurrency: Object.freeze({ name: 'POL', symbol: 'POL', decimals: 18 }),
  rpcUrl: 'https://rpc-amoy.polygon.technology',
  blockExplorerUrl: AMOY_EXPLORER,
});

export function chainConfig(chainId = AMOY_CHAIN_ID) {
  if (Number(chainId) !== AMOY_CHAIN_ID) {
    throw new Error(`Unsupported chain ${chainId}. This release supports Polygon Amoy only.`);
  }
  return POLYGON_AMOY;
}
