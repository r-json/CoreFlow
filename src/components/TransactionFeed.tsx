'use client';

import { ArrowUpRight, Check, Clock, FileText } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './Card';

export interface Transaction {
  id: string;
  type: 'approval' | 'payment' | 'submission';
  escrowId: number;
  hash: string;
  status: 'pending' | 'success' | 'failed';
  timestamp: string;
  details: string;
}

interface TransactionFeedProps {
  transactions: Transaction[];
}

export const TransactionFeed = ({ transactions }: TransactionFeedProps) => {
  const getIcon = (type: string) => {
    switch (type) {
      case 'approval': return <Check className="w-3.5 h-3.5" />;
      case 'submission': return <FileText className="w-3.5 h-3.5" />;
      case 'payment': return <ArrowUpRight className="w-3.5 h-3.5" />;
      default: return <Clock className="w-3.5 h-3.5" />;
    }
  };

  return (
    <div className="rounded-2xl border border-violet-500/30 bg-gradient-to-br from-violet-950/40 via-slate-900/50 to-purple-900/30 backdrop-blur-xl p-4 shadow-2xl shadow-violet-500/15">
      <div className="space-y-2 max-h-[600px] overflow-y-auto pr-1 custom-scrollbar">
        {transactions.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-8">No transactions yet</p>
        ) : (
          transactions.map((tx) => (
            <div key={tx.id} className="group flex items-center gap-3 p-3 rounded-xl hover:bg-white/5 transition-all duration-200">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                tx.status === 'success' 
                  ? 'bg-violet-500/20 text-violet-400 border border-violet-500/30' 
                  : tx.status === 'pending'
                  ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30'
                  : 'bg-red-500/20 text-red-400 border border-red-500/30'
              }`}>
                {getIcon(tx.type)}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-200 truncate">{tx.details}</p>
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span>Escrow #{tx.escrowId}</span>
                  <span>•</span>
                  <span>{tx.timestamp}</span>
                </div>
              </div>
              <a 
                href={`https://stellar.expert/explorer/testnet/tx/${tx.hash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
              >
                <ArrowUpRight className="w-4 h-4 text-slate-500 hover:text-violet-400" />
              </a>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
