'use client';

import { Download, CheckCircle } from 'lucide-react';
import { Button } from './Button';

interface PaymentReceiptProps {
  escrowId: number;
  workerAddress: string;
  amountUsdc: number;
  amountPhp: number;
  feeSavedUsd: number;
  transactionHash: string;
  timestamp: string;
}

export const PaymentReceipt = ({
  escrowId,
  workerAddress,
  amountUsdc,
  amountPhp,
  feeSavedUsd,
  transactionHash,
  timestamp,
}: PaymentReceiptProps) => {
  const handleDownload = () => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('Please allow popups to download/print the PDF receipt.');
      return;
    }

    const receiptHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>CoreFlow Receipt - Escrow #${escrowId}</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            color: #1e293b;
            margin: 0;
            padding: 40px;
            background-color: #ffffff;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          .receipt-container {
            max-width: 700px;
            margin: 0 auto;
            border: 1px solid #e2e8f0;
            border-radius: 16px;
            padding: 40px;
            box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.05);
          }
          .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 2px solid #6d28d9;
            padding-bottom: 20px;
            margin-bottom: 30px;
          }
          .brand {
            font-size: 24px;
            font-weight: 800;
            color: #6d28d9;
            letter-spacing: -0.025em;
          }
          .title {
            text-align: right;
            font-size: 14px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: #64748b;
          }
          .grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
            margin-bottom: 40px;
          }
          .meta-label {
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: #94a3b8;
            margin-bottom: 4px;
          }
          .meta-val {
            font-size: 13px;
            font-weight: 500;
            color: #334155;
            font-family: monospace;
            word-break: break-all;
          }
          .summary-table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 30px;
          }
          .summary-table th {
            text-align: left;
            padding: 12px;
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: #475569;
            background-color: #f8fafc;
            border-bottom: 2px solid #e2e8f0;
          }
          .summary-table td {
            padding: 16px 12px;
            font-size: 14px;
            border-bottom: 1px solid #f1f5f9;
          }
          .summary-table td.amount {
            font-weight: 700;
            color: #0f172a;
          }
          .savings-card {
            background-color: #f0fdf4;
            border: 1px solid #bbf7d0;
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 35px;
            display: flex;
            justify-content: space-between;
            align-items: center;
          }
          .savings-title {
            font-size: 14px;
            font-weight: 700;
            color: #166534;
          }
          .savings-desc {
            font-size: 12px;
            color: #15803d;
            margin-top: 2px;
          }
          .savings-amount {
            font-size: 20px;
            font-weight: 900;
            color: #166534;
            text-align: right;
          }
          .footer {
            text-align: center;
            font-size: 11px;
            color: #94a3b8;
            border-top: 1px solid #e2e8f0;
            padding-top: 20px;
            line-height: 1.6;
          }
          @media print {
            body {
              padding: 0;
            }
            .receipt-container {
              border: none;
              box-shadow: none;
              padding: 0;
            }
          }
        </style>
      </head>
      <body>
        <div class="receipt-container">
          <div class="header">
            <span class="brand">CoreFlow</span>
            <span class="title">Official Payment Receipt</span>
          </div>

          <div class="grid">
            <div>
              <div class="meta-label">Status</div>
              <div class="meta-val" style="color: #166534; font-weight: 700;">Settled (On-Chain Finalized)</div>
            </div>
            <div>
              <div class="meta-label">Settlement Network</div>
              <div class="meta-val">Stellar Public Network (Mainnet)</div>
            </div>
            <div>
              <div class="meta-label">Escrow ID</div>
              <div class="meta-val">#${escrowId}</div>
            </div>
            <div>
              <div class="meta-label">Timestamp</div>
              <div class="meta-val">${timestamp}</div>
            </div>
            <div style="grid-column: span 2;">
              <div class="meta-label">Recipient Worker Address</div>
              <div class="meta-val" style="font-size: 12px;">${workerAddress}</div>
            </div>
            <div style="grid-column: span 2;">
              <div class="meta-label">Transaction Hash</div>
              <div class="meta-val" style="font-size: 11px;">${transactionHash}</div>
            </div>
          </div>

          <table class="summary-table">
            <thead>
              <tr>
                <th>Description</th>
                <th style="text-align: right;">Amount (USDC)</th>
                <th style="text-align: right;">Amount (PHP)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style="font-weight: 600; color: #334155;">Escrow Payout Settlement</td>
                <td class="amount" style="text-align: right;">$${amountUsdc.toFixed(2)} USDC</td>
                <td class="amount" style="text-align: right; color: #166534;">₱${amountPhp.toLocaleString('en-US', { maximumFractionDigits: 2 })} PHP</td>
              </tr>
            </tbody>
          </table>

          <div class="savings-card">
            <div>
              <div class="savings-title">Stellar Network Fee Savings</div>
              <div class="savings-desc">vs. Traditional Bank Wire (5.5% standard fee)</div>
            </div>
            <div>
              <div class="savings-amount">$${feeSavedUsd.toFixed(2)} USD</div>
              <div class="savings-desc" style="font-weight: 700;">Saved ≈ 99.9%</div>
            </div>
          </div>

          <div class="footer">
            This receipt was generated automatically from cryptographic ledger records on the Stellar blockchain.<br />
            To verify this transaction independently, query the hash above at <strong>https://stellar.expert</strong>.
          </div>
        </div>
        <script>
          window.onload = function() {
            setTimeout(function() {
              window.print();
            }, 300);
          }
        </script>
      </body>
      </html>
    `;

    printWindow.document.write(receiptHtml);
    printWindow.document.close();
  };

  return (
    <div className="mt-4 p-4 rounded-xl border border-slate-800 bg-slate-950/80 backdrop-blur-md">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-emerald-400">
          <CheckCircle className="w-4 h-4" />
          <span className="text-xs font-semibold uppercase tracking-wider">Payment Released</span>
        </div>
        <Button
          onClick={handleDownload}
          size="sm"
          className="bg-slate-900 hover:bg-slate-800 text-slate-300 border border-white/10 text-xs px-3 py-1 flex items-center gap-1.5"
        >
          <Download className="w-3.5 h-3.5" />
          Print / Save PDF
        </Button>
      </div>

      <div className="space-y-1.5 text-xs font-mono text-slate-400">
        <div className="flex justify-between">
          <span>Escrow ID:</span>
          <span className="text-slate-200">#{escrowId}</span>
        </div>
        <div className="flex justify-between">
          <span>Amount PHP:</span>
          <span className="text-emerald-400 font-semibold">₱{amountPhp.toLocaleString('en-US', { maximumFractionDigits: 2 })} PHP</span>
        </div>
        <div className="flex justify-between">
          <span>Fee Saved:</span>
          <span className="text-emerald-400 font-semibold">${feeSavedUsd.toFixed(2)} USD</span>
        </div>
        <div className="flex justify-between items-center gap-4">
          <span>Tx Hash:</span>
          <span className="text-slate-500 truncate max-w-[150px]" title={transactionHash}>{transactionHash}</span>
        </div>
      </div>
    </div>
  );
};
