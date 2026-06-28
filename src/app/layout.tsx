import type { Metadata } from 'next';
import { Outfit } from 'next/font/google';
import './globals.css';

const outfit = Outfit({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-outfit',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'CoreFlow — Trustless Payroll & B2B Escrow on Stellar',
    template: '%s · CoreFlow',
  },
  description:
    'On-chain accounts payable and payroll escrow for distributed teams: multi-signature approvals, oracle-verified work hours, and USDC custody on Stellar Soroban.',
  keywords: ['Stellar', 'Soroban', 'escrow', 'payroll', 'USDC', 'smart contract', 'web3 payments'],
  openGraph: {
    title: 'CoreFlow — Trustless Payroll & B2B Escrow on Stellar',
    description:
      'Multi-signature, oracle-verified, USDC-settled payroll escrow on Stellar Soroban.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'CoreFlow — Trustless Payroll & B2B Escrow on Stellar',
    description:
      'Multi-signature, oracle-verified, USDC-settled payroll escrow on Stellar Soroban.',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={outfit.variable}>
      <body className={outfit.className}>{children}</body>
    </html>
  );
}
