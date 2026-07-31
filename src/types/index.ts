import { Role } from '@prisma/client';

export type UserRole = Role;
export type EscrowStatusType = 'pending_manager' | 'pending_finance' | 'ready' | 'paid' | 'cancelled' | 'rejected';

export interface UserProfile {
  id: string;
  walletAddress: string;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentScheduleItem {
  id: number;
  worker: string;
  amount: string | number;
  startDate: number;
  endDate: number;
  hoursLogged: number;
  ratePerHour: string | number;
  status: 'PENDING' | 'MANAGER_APPROVED' | 'FINANCE_APPROVED' | 'FINALIZED' | 'CANCELLED';
}

export interface EscrowRecord {
  id: string;
  onChainId: number | null;
  contractId: string;
  managerAddress: string;
  financeApprover: string;
  tokenAddress: string;
  oraclePubkey: string;
  totalAmount: string | number;
  status: EscrowStatusType;
  managerApproved: boolean;
  financeApproved: boolean;
  cancelled: boolean;
  rejectionReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TimeLogRecord {
  id: string;
  escrowId: string;
  paymentId: number;
  workerAddress: string;
  hoursLogged: number;
  ratePerHour: string | number;
  totalAmount: string | number;
  status: string;
  createdAt: Date;
}

export interface AuditLogRecord {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  metadata: Record<string, any> | null;
  createdAt: Date;
}

export interface InvitationRecord {
  id: string;
  email: string;
  role: Role;
  token: string;
  expiresAt: Date;
  usedAt?: Date | null;
  createdAt: Date;
}
