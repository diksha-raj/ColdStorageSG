// A client-side mirror of CertificateRegistry.stageFlags (minus the sensor part), used only to
// preview "this will flag the stage" while someone fills in a check. The contract is the authority.
import type { FlagReason } from "./types";

type CheckValues = { tempC: number; unrefrigeratedMinutes: number; damaged: boolean; sealIntact: boolean; issues: boolean };

export function checkpointReasons(
  outgoing: Pick<CheckValues, "unrefrigeratedMinutes" | "issues">,
  incoming: CheckValues,
  limitC: number,
  graceMinutes: number,
): FlagReason[] {
  const reasons: FlagReason[] = [];
  if (incoming.tempC > limitC) reasons.push("receipt_temp");
  if (outgoing.unrefrigeratedMinutes + incoming.unrefrigeratedMinutes > graceMinutes) reasons.push("unrefrigerated");
  if (incoming.damaged || !incoming.sealIntact || incoming.issues || outgoing.issues) reasons.push("condition");
  return reasons;
}

/** Converts form values to the contract's CheckInput tuple. */
export function toCheckInput(v: CheckValues, notesHash: string) {
  return {
    tempTenthsC: Math.round(v.tempC * 10),
    unrefrigeratedMinutes: Math.round(v.unrefrigeratedMinutes),
    damaged: v.damaged,
    sealIntact: v.sealIntact,
    issues: v.issues,
    notesHash,
  };
}
