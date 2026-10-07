// Participants by wallet, loaded once for the signed-in app, so organisation names can be shown
// instead of addresses everywhere without each component fetching its own copy.
import { type ReactNode, createContext, useContext } from "react";
import { useApi } from "./hooks";
import type { Participant } from "./types";

type Participants = {
  list: Participant[];
  get: (wallet?: string | null) => Participant | undefined;
  ofRole: (role: string) => Participant[];
  reload: () => Promise<void>;
};

const ParticipantsContext = createContext<Participants | null>(null);

export function ParticipantsProvider({ children }: { children: ReactNode }) {
  const { data, reload } = useApi<Participant[]>("identity", "/participants", 15000);
  const list = data ?? [];
  const byWallet = new Map(list.map((p) => [p.wallet.toLowerCase(), p]));
  const value: Participants = {
    list,
    get: (wallet) => (wallet ? byWallet.get(wallet.toLowerCase()) : undefined),
    ofRole: (role) => list.filter((p) => p.role === role && p.active),
    reload,
  };
  return <ParticipantsContext.Provider value={value}>{children}</ParticipantsContext.Provider>;
}

export function useParticipants() {
  const ctx = useContext(ParticipantsContext);
  if (!ctx) throw new Error("useParticipants must be used inside ParticipantsProvider");
  return ctx;
}
