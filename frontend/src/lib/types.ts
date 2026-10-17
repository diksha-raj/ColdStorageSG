// Shapes returned by the backend services.
import type { Role } from "./format";

export type Participant = { wallet: string; org_name: string; contact_email: string; role: Role; active: boolean };

export type Unit = {
  id: number;
  kind: "container" | "batch";
  containerId: number;
  supplier: string;
  custodian: string | null;
  pendingTo: string | null;
  stage: string;
  splitAt: number | null;
  sensorId: string;
  containerCode: string; // ISO 6346, e.g. CCSU4831207; a batch carries its container's
  sealNumber: string | null; // the supplier's seal, recorded before dispatch
  buyer?: string;
  inspector?: string;
  thresholdC?: number;
  graceMinutes?: number;
  container?: { stage: string; splitAt: number | null }; // batches: where their container is
  details: { origin?: string; departureDate?: string; product?: string; quantity?: number; unit?: string } | null;
};

/** One side of a handover quality check, as signed on-chain, plus its sealed off-chain notes. */
export type Check = {
  tempC: number;
  unrefrigeratedMinutes: number;
  damaged: boolean;
  sealIntact: boolean;
  issues: boolean;
  notesHash: string;
  by: string;
  checkedAt: number;
  sealed: SealedNotes | null;
};

export type ManualReading = { takenAt: string; tempC: number; note: string; by: string };
export type IssueReport = { category: string; unrefrigeratedMinutes: number; description: string; reportedAt: string; by: string };
export type SealedNotes = { note: string; readings?: ManualReading[]; issues?: IssueReport[]; by: string; sealedAt: string };

/** The handover that closed `stage` (0 = origin dispatch ... 4 = truck → buyer). */
export type Checkpoint = { stage: number; recordedOn: number; outgoing: Check | null; incoming: Check | null };

export type LegLog = {
  stage: number;
  readings: ManualReading[];
  issues: IssueReport[];
  digest: { readings: number; maxTempC: number | null; issues: number; unrefrigeratedMinutes: number };
};

export type ShipmentDetail = Unit & {
  history: { custodian: string; stage: string; startedAt: number }[];
  batches: Unit[];
  checkpoints: Checkpoint[];
  pendingCheck: Check | null;
};

export type FlagReason = "sensor_excursion" | "receipt_temp" | "unrefrigerated" | "condition";

export type LegPass =
  | { leg: number; pending: true }
  | {
      id: number;
      leg: number;
      custodian: string;
      status: "pass" | "flagged";
      reasons: FlagReason[];
      receiptTempC: number;
      unrefrigeratedMinutes: number;
      fileHash: string;
      maxTempC: number;
      breachMinutes: number;
      issuedAt: number;
      pending?: undefined;
    };

/** Live view of a stage: flags so far, and whether its checkpoint / sensor log are in. */
export type StageStatus = { stage: number; reasons: FlagReason[]; checkpointDone: boolean; sensorDone: boolean };

export type Claim = {
  id: number;
  batchId: number;
  leg: number;
  reasons: FlagReason[];
  breachStart: number | null;
  breachEnd: number | null;
  provisionalCustodian: string;
  openedAt: number;
  status: "open" | "resolved";
  resolution: { id: number; inspector: string; outcome: Outcome; note: string; signedAt: number } | null;
  inspectionNotes: { author: string; body: string; created_at: string }[];
};

export type Outcome = "upheld" | "overturned" | "compensation_agreed";

export type BatchCertificate = {
  batchId: number;
  stages: StageStatus[];
  legPasses: LegPass[];
  claims: Claim[];
  certificate: { status: "clean" | "flagged" | "resolved"; legPassIds: number[]; resolutionIds: number[]; issuedAt: number } | null;
  decision: { disposition: "released" | "rejected"; inspector: string; note: string; decidedAt: number } | null;
  acknowledgement: { buyer: string; acknowledgedAt: number } | null;
};

export type Reading = { at: number; tempC: number };

export type Evidence = {
  batchId: number;
  thresholdC: number;
  graceMinutes: number;
  legs: {
    leg: number;
    custodian: string | null;
    start: number | null;
    end: number | null;
    sensorId: string;
    committedHash: string | null;
    summary: {
      status: "Verified" | "EvidenceMismatch";
      fileHash: string;
      minC: number;
      maxC: number;
      breachMinutes: number;
      breachStart: number | null;
      breachEnd: number | null;
      submittedAt: number;
    } | null;
    latestUpload: { id: number; fileName: string; uploadedBy: string; uploadedAt: string; readings: Reading[] } | null;
  }[];
};

/** A custody leg's evidence status, from the Oracle Service. */
export type LegStatus = {
  shipmentId: number; // container for legs 1-3, batch for leg 4
  containerCode: string;
  leg: number;
  custodian: string | null;
  start: number | null;
  end: number | null;
  sensorId: string;
  recording: "compliant" | "breach";
  sensorCommitted: boolean;
  evidence: { batchId: number; status: "None" | "Verified" | "EvidenceMismatch" }[];
  awaitingUpload: boolean;
  stagedUpload: { fileName: string; uploadedAt: string } | null; // uploaded at handover, checked when the leg closes
};

export type UploadResult = {
  fileHash: string;
  committedHash: string;
  matches: boolean;
  results: { batchId: number; status: string; thresholdC: number; maxC: number; breachMinutes: number }[];
};
