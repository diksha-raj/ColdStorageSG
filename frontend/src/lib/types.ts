// Shapes returned by the backend services.
import type { Role } from "./format";

export type Participant = { wallet: string; org_name: string; contact_email: string; role: Role; active: boolean };

export type Unit = {
  id: number;
  kind: "container" | "batch";
  containerId: number | null; // a batch's container, once Cargo has received it
  custodian: string | null;
  pendingTo: string | null;
  stage: string;
  createdAt: number;
  unloadedAt: number | null; // containers: when the cold store unloaded it
  containerCode: string | null; // ISO 6346, e.g. CCSU1126480; a batch carries its container's
  sealNumber: string | null; // the seal Cargo applied after loading
  inContainer?: boolean; // batches: still inside their (not yet unloaded) container
  holders: string[]; // everyone who has held it
  sensorId: string | null; // the sensor covering its current stage (inside a container: the container's)
  supplier?: string;
  buyer?: string;
  inspector?: string;
  thresholdC?: number;
  graceMinutes?: number;
  details: {
    product?: string;
    quantity?: number;
    unit?: string;
    mode?: "air" | "sea";
    voyage?: string;
    origin?: string;
    destination?: string;
    departureDate?: string;
  } | null;
};

/** One side of a handover quality check, as signed on-chain, plus its sealed off-chain notes. */
export type Check = {
  tempC: number;
  damaged: boolean;
  sealIntact: boolean;
  issues: boolean;
  notesHash: string;
  by: string;
  checkedAt: number; // sender: exit time; receiver: entry time
  sealed: SealedNotes | null;
};

export type ManualReading = { takenAt: string; tempC: number; note: string; by: string };
export type IssueReport = { category: string; unrefrigeratedMinutes: number; description: string; reportedAt: string; by: string };
export type SealedNotes = { note: string; readings?: ManualReading[]; issues?: IssueReport[]; by: string; sealedAt: string };

/** The handover that closed `stage` (0 = supplier → Cargo ... 4 = truck → buyer). */
export type Checkpoint = { stage: number; recordedOn: number | null; outgoing: Check | null; incoming: Check | null };

export type LegLog = {
  stage: number;
  readings: ManualReading[];
  issues: IssueReport[];
  digest: { readings: number; maxTempC: number | null; issues: number; unrefrigeratedMinutes: number };
};

export type RegisteredSensor = { stage: number; sensorId: string; device: string; owner: string; registeredAt: number };

export type ShipmentDetail = Unit & {
  history: { custodian: string; stage: string; startedAt: number }[];
  batches: Unit[];
  container: Unit | null;
  checkpoints: Checkpoint[];
  pendingCheck: Check | null;
  sensors: RegisteredSensor[];
};

export type FlagReason = "sensor_excursion" | "receipt_temp" | "handover_gap" | "condition" | "missing_data";

export type LegPass =
  | { leg: number; pending: true }
  | {
      id: number;
      leg: number;
      custodian: string;
      status: "pass" | "flagged";
      reasons: FlagReason[];
      receiptTempC: number;
      gapMinutes: number;
      fileHash: string;
      maxTempC: number;
      breachMinutes: number;
      missingMinutes: number;
      issuedAt: number;
      pending?: undefined;
    };

/** Live view of a stage: flags so far, and whether its closing handover / sensor readings are in. */
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

/** A sensor as the sensor gateway knows it. */
export type GatewaySensor = { sensorId: string; owner: string; mode: "compliant" | "breached" | "feed" | null; label: string; device?: string };

/** Per stage of a batch: its sensor, readings and summary, and the handover gap that followed. */
export type StageEvidence = {
  stage: number;
  custodian: string | null;
  recordedOn: number | null;
  start: number | null; // entry
  end: number | null; // exit (0/null while in progress)
  sensor: GatewaySensor | null;
  committed: { fileHash: string; txHash: string; matchesChain: boolean } | null;
  summary: {
    status: "Verified" | "EvidenceMismatch";
    fileHash: string;
    minC: number;
    maxC: number;
    breachMinutes: number;
    missingMinutes: number;
    breachStart: number | null;
    breachEnd: number | null;
  } | null;
  readings: Reading[];
  gap: { from: number; to: number; minutes: number } | null;
};

export type Evidence = {
  batchId: number;
  thresholdC: number;
  graceMinutes: number;
  stages: StageEvidence[];
};
