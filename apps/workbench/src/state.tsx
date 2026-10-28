import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { navigate } from './lib/router';

/** What one page hands to Verify. */
export interface VerifyDraft {
  claimJSON: string;
  signatureHex: string;
  passphrase: string;
  contractId: string;
  /** Unix seconds to verify at; empty for the current time. */
  at?: string;
  source: string;
}

/** What one page hands to Inspect. */
export interface InspectDraft {
  preimageHex: string;
  signatureHex?: string;
  passphrase?: string;
  contractId?: string;
  compareHex?: string;
  source: string;
}

interface Handoff {
  verifyDraft?: VerifyDraft;
  inspectDraft?: InspectDraft;
  openInVerify: (draft: VerifyDraft) => void;
  openInInspect: (draft: InspectDraft) => void;
}

const HandoffContext = createContext<Handoff | null>(null);

/**
 * Lets a page open another page with values filled in. Drafts live in
 * memory only: nothing is written to storage or sent anywhere.
 */
export function HandoffProvider({ children }: { children: ReactNode }) {
  const [verifyDraft, setVerifyDraft] = useState<VerifyDraft>();
  const [inspectDraft, setInspectDraft] = useState<InspectDraft>();
  const value = useMemo<Handoff>(
    () => ({
      verifyDraft,
      inspectDraft,
      openInVerify: (draft) => {
        setVerifyDraft(draft);
        navigate('verify');
      },
      openInInspect: (draft) => {
        setInspectDraft(draft);
        navigate('inspect');
      },
    }),
    [verifyDraft, inspectDraft],
  );
  return <HandoffContext.Provider value={value}>{children}</HandoffContext.Provider>;
}

export function useHandoff(): Handoff {
  const value = useContext(HandoffContext);
  if (!value) throw new Error('useHandoff must be used inside HandoffProvider');
  return value;
}
