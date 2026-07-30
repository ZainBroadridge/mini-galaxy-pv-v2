import { JsonRpcProvider, Wallet } from 'ethers';
import { config } from './config.js';

export const provider = new JsonRpcProvider(config.rpcUrl, config.chainId, { staticNetwork: true });
export const archiveProvider = new JsonRpcProvider(config.archiveRpcUrl, config.chainId, { staticNetwork: true });
export const relayer = new Wallet(config.relayerPrivateKey, provider);
