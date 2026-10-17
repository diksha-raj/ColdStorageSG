// A client-side mirror of the handover part of CertificateRegistry.stageFlags, used only to preview
// "this will flag the stage" while someone fills in a check. The contract is the authority; the
// handover gap and the sensor are judged there once the handover is signed.
import type { FlagReason } from "./types";

type CheckValues = { tempC: number; damaged: boolean; sealIntact: boolean; issues: boolean };

export function checkpointReasons(outgoing: Pick<CheckValues, "issues">, incoming: CheckValues, limitC: number): FlagReason[] {
  const reasons: FlagReason[] = [];
  if (incoming.tempC > limitC) reasons.push("receipt_temp");
  if (incoming.damaged || !incoming.sealIntact || incoming.issues || outgoing.issues) reasons.push("condition");
  return reasons;
}

/** Converts form values to the contract's CheckInput tuple. */
export function toCheckInput(v: CheckValues, notesHash: string) {
  return {
    tempTenthsC: Math.round(v.tempC * 10),
    damaged: v.damaged,
    sealIntact: v.sealIntact,
    issues: v.issues,
    notesHash,
  };
}
