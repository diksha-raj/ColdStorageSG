export type Role =
  | "ADMIN"
  | "IMPORTER"
  | "CARRIER"
  | "HANDLER"
  | "COLD_STORE"
  | "TRUCK"
  | "BUYER"
  | "INSPECTOR"
  | "ORACLE"
  | "CERTIFIER";

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "Admin",
  IMPORTER: "Importer",
  CARRIER: "Air carrier",
  HANDLER: "Changi handler",
  COLD_STORE: "Importer cold store",
  TRUCK: "Delivery truck",
  BUYER: "Buyer",
  INSPECTOR: "QA inspector",
  ORACLE: "Oracle service",
  CERTIFIER: "Certificate service",
};

/** Roles a person can request access for. */
export const REQUESTABLE_ROLES: Role[] = ["IMPORTER", "CARRIER", "HANDLER", "COLD_STORE", "TRUCK", "BUYER", "INSPECTOR"];

export const STAGE_LABELS: Record<string, string> = {
  Origin: "At origin",
  Carrier: "With air carrier",
  Handler: "With Changi handler",
  ColdStore: "At importer cold store",
  Truck: "On delivery truck",
  Delivered: "Delivered",
};

/** Stage names. Stage 0 is the importer's dispatch from origin; 1-4 are the custody legs. */
export const LEG_NAMES: Record<number, string> = {
  0: "Origin dispatch",
  1: "Air carrier",
  2: "Changi handler",
  3: "Importer cold store",
  4: "Delivery truck",
};

/** How the next custodian reads mid-sentence ("Hand over to the …"). */
export const HANDOVER_TARGET: Partial<Record<Role, string>> = {
  CARRIER: "air carrier",
  HANDLER: "Changi handler",
  COLD_STORE: "importer cold store",
  TRUCK: "delivery truck",
  BUYER: "buyer",
};

/** Which role receives the shipment next, by current stage. Delivered goes to the batch's buyer. */
export const NEXT_ROLE: Record<string, Role | undefined> = {
  Origin: "CARRIER",
  Carrier: "HANDLER",
  Handler: "COLD_STORE",
  ColdStore: "TRUCK",
  Truck: "BUYER",
};

export const shortAddress = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
export const shortHash = (h?: string | null) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "—");
export const sameAddress = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function formatTime(unix?: number | null) {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleString("en-SG", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const formatDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" }) : "—";

export const unitLabel = (u: { kind: string; id: number }) => (u.kind === "container" ? `Container #${u.id}` : `Batch #${u.id}`);

/** The handover that closes each stage: "<from> → <to>". */
export const HANDOVER_NAMES: Record<number, string> = {
  0: "Importer → Air carrier",
  1: "Air carrier → Changi handler",
  2: "Changi handler → Cold store",
  3: "Cold store → Delivery truck",
  4: "Delivery truck → Buyer",
};

export const REASON_LABELS: Record<string, string> = {
  sensor_excursion: "Sensor log above limit too long",
  receipt_temp: "Too warm on receipt",
  unrefrigerated: "Too long without refrigeration",
  condition: "Damage, broken seal or reported issue",
};

export const ISSUE_CATEGORIES: Record<string, string> = {
  refrigeration_failure: "Refrigeration failure",
  temperature_excursion: "Temperature excursion",
  packaging_damage: "Packaging damage",
  seal_broken: "Seal broken",
  delay: "Delay",
  other: "Other",
};

/** Where a batch is: before the split it travels inside its container, so use the container's stage. */
export function whereIs(u: { kind: string; stage: string; containerId: number; container?: { stage: string; splitAt: number | null } }) {
  if (u.kind === "batch" && u.stage === "Origin" && u.container) {
    const where = u.container.splitAt ? "split" : STAGE_LABELS[u.container.stage];
    return `In container #${u.containerId} · ${where[0].toLowerCase()}${where.slice(1)}`; // "with Changi handler"
  }
  return STAGE_LABELS[u.stage];
}
