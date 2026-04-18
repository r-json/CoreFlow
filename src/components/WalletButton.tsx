'use client';

import { useState, useEffect } from 'react';
import { Button } from './Button';
import { STELLAR_CONFIG } from '@/lib/config';

interface WalletButtonProps {
  onConnect?: (address: string) => void;
  onDisconnect?: () => void;
}

export const WalletButton = ({ onConnect, onDisconnect }: WalletButtonProps) => {
  const [isConnected, setIsConnected] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    checkConnection();
  }, []);

  const checkConnection = async () => {
    try {
      const connected = await STELLAR_CONFIG.freighter.isConnected();
      setIsConnected(connected);
    } catch (err) {
      console.error('Error checking connection:', err);
    }
  };

  const handleConnect = async () => {
    try {
      setIsLoading(true);
      setError(null);
      const addr = await STELLAR_CONFIG.freighter.connect();
      setAddress(addr);
      setIsConnected(true);
      onConnect?.(addr);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to connect wallet';
      setError(errorMsg);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDisconnect = () => {
    setAddress(null);
    setIsConnected(false);
    onDisconnect?.();
  };

  return (
    <div className="flex items-center gap-3">
      {error && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-red-400">{error}</span>
          {error.includes('not found') && (
            <a 
              href="https://freighter.app/" 
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-slate-500 hover:text-violet-400 underline"
            >
              Install Freighter
            </a>
          )}
        </div>
      )}
      
      {isConnected && address ? (
        <button className="flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-to-r from-slate-800 to-slate-900 border border-violet-500/30 hover:border-violet-500/50 transition-all shadow-lg shadow-black/20 hover:shadow-violet-500/10">
          <div className="w-2 h-2 rounded-full bg-violet-400 animate-pulse" />
          <span className="text-sm font-medium text-slate-200">
            {address.slice(0, 6)}...{address.slice(-4)}
          </span>
          <span className="w-1 h-1 rounded-full bg-slate-600" />
          <span className="text-xs text-violet-400 font-medium">Testnet</span>
          <button
            onClick={handleDisconnect}
            className="ml-2 text-xs text-slate-400 hover:text-slate-200 transition-colors"
          >
            ✕
          </button>
        </button>
      ) : (
        <Button
          onClick={handleConnect}
          isLoading={isLoading}
          disabled={isLoading}
          title="Install Freighter wallet from https://freighter.app if not already installed"
          className="bg-gradient-to-r from-violet-600 to-violet-500 hover:from-violet-500 hover:to-violet-400"
        >
          Connect Freighter
        </Button>
      )}
    </div>
  );
};
