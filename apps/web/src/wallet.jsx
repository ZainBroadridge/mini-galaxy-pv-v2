import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { BrowserProvider } from 'ethers';
import { AMOY_CHAIN_HEX, AMOY_CHAIN_ID, POLYGON_AMOY } from '@pv/shared';
import { api, getStoredSession, storeSession } from './api.js';

const WalletContext = createContext(null);

function injectedProvider() {
  if (!window.ethereum?.request) throw new Error('MetaMask is required for this V2 dApp.');
  return window.ethereum;
}

async function switchToAmoy() {
  const ethereum = injectedProvider();
  try {
    await ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: AMOY_CHAIN_HEX }],
    });
  } catch (error) {
    if (error.code !== 4902) throw error;
    await ethereum.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: POLYGON_AMOY.chainIdHex,
        chainName: POLYGON_AMOY.name,
        nativeCurrency: POLYGON_AMOY.nativeCurrency,
        rpcUrls: [import.meta.env.VITE_PUBLIC_RPC_URL ?? POLYGON_AMOY.rpcUrl],
        blockExplorerUrls: [
          import.meta.env.VITE_BLOCK_EXPLORER_URL ?? POLYGON_AMOY.blockExplorerUrl,
        ],
      }],
    });
  }
}

export function WalletProvider({ children }) {
  const [account, setAccount] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [session, setSession] = useState(getStoredSession());
  const [busy, setBusy] = useState(false);

  const refreshPassive = useCallback(async () => {
    if (!window.ethereum?.request) return;
    const [accounts, chainHex] = await Promise.all([
      window.ethereum.request({ method: 'eth_accounts' }),
      window.ethereum.request({ method: 'eth_chainId' }),
    ]);
    setAccount(accounts?.[0]?.toLowerCase() ?? null);
    setChainId(Number.parseInt(chainHex, 16));
  }, []);

  useEffect(() => {
    refreshPassive().catch(() => {});
    if (!window.ethereum?.on) return undefined;
    const handleAccounts = (accounts) => {
      const next = accounts?.[0]?.toLowerCase() ?? null;
      setAccount(next);
      const stored = getStoredSession();
      if (!next || (stored?.walletAddress && stored.walletAddress.toLowerCase() !== next)) {
        storeSession(null);
        setSession(null);
      }
      // Deliberately preserve the active route. Account changes never redirect.
    };
    const handleChain = (chainHex) => setChainId(Number.parseInt(chainHex, 16));
    window.ethereum.on('accountsChanged', handleAccounts);
    window.ethereum.on('chainChanged', handleChain);
    return () => {
      window.ethereum.removeListener?.('accountsChanged', handleAccounts);
      window.ethereum.removeListener?.('chainChanged', handleChain);
    };
  }, [refreshPassive]);

  const authenticate = useCallback(async (walletAddress) => {
    const challenge = await api('/v1/auth/nonce', {
      method: 'POST',
      body: { walletAddress },
    });
    const browserProvider = new BrowserProvider(injectedProvider());
    const signer = await browserProvider.getSigner();
    const signature = await signer.signMessage(challenge.message);
    const nextSession = await api('/v1/auth/verify', {
      method: 'POST',
      body: { walletAddress, signature },
    });
    storeSession(nextSession);
    setSession(nextSession);
    return nextSession;
  }, []);

  const connect = useCallback(async () => {
    setBusy(true);
    try {
      await switchToAmoy();
      const accounts = await injectedProvider().request({ method: 'eth_requestAccounts' });
      const wallet = accounts[0].toLowerCase();
      setAccount(wallet);
      setChainId(AMOY_CHAIN_ID);
      const stored = getStoredSession();
      if (!stored || stored.walletAddress.toLowerCase() !== wallet) {
        await authenticate(wallet);
      } else {
        setSession(stored);
      }
      return wallet;
    } finally {
      setBusy(false);
    }
  }, [authenticate]);

  const ensureAuthenticated = useCallback(async () => {
    let wallet = account;
    if (!wallet) wallet = await connect();
    if (chainId !== AMOY_CHAIN_ID) {
      await switchToAmoy();
      setChainId(AMOY_CHAIN_ID);
    }
    const stored = getStoredSession();
    if (!stored || stored.walletAddress.toLowerCase() !== wallet) {
      return authenticate(wallet);
    }
    setSession(stored);
    return stored;
  }, [account, authenticate, chainId, connect]);

  const logoutPortal = useCallback(async () => {
    try {
      await api('/v1/auth/logout', { method: 'POST' });
    } catch {
      // Local session removal still proceeds.
    }
    storeSession(null);
    setSession(null);
  }, []);

  const getSigner = useCallback(async () => {
    await ensureAuthenticated();
    const browserProvider = new BrowserProvider(injectedProvider());
    return browserProvider.getSigner();
  }, [ensureAuthenticated]);

  const value = useMemo(() => ({
    account,
    chainId,
    connected: Boolean(account),
    authenticated: Boolean(session),
    busy,
    connect,
    logoutPortal,
    ensureAuthenticated,
    getSigner,
    refreshPassive,
  }), [
    account,
    chainId,
    session,
    busy,
    connect,
    logoutPortal,
    ensureAuthenticated,
    getSigner,
    refreshPassive,
  ]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const value = useContext(WalletContext);
  if (!value) throw new Error('useWallet must be used within WalletProvider.');
  return value;
}
