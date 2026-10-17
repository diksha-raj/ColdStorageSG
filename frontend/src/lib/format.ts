export type Role =
  | "ADMIN"
  | "SUPPLIER"
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
  SUPPLIER: "Supplier",
  CARRIER: "Cargo",
  HANDLER: "Destination Freight Handler",
  COLD_STORE: "Cold Store",
  TRUCK: "Reefer Truck",
  BUYER: "Buyer",
  INSPECTOR: "Quality Inspector",
  ORACLE: "Oracle service",
  CERTIFIER: "Certificate service",
};

/** Roles a person can request access for. */
export const REQUESTABLE_ROLES: Role[] = ["SUPPLIER", "CARRIER", "HANDLER", "COLD_STORE", "TRUCK", "BUYER", "INSPECTOR"];

export const STAGE_LABELS: Record<string, string> = {
  Origin: "At origin",
  Carrier: "With Cargo",
  Handler: "With Destination Freight Handler",
  ColdStore: "At Cold Store",
  Truck: "On Reefer Truck",
  Delivered: "Delivered",
};

/** Stage names. Stage 0 is the supplier's dispatch from origin; 1-4 are the custody legs. */
export const LEG_NAMES: Record<number, string> = {
  0: "Origin dispatch",
  1: "Cargo",
  2: "Destination Freight Handler",
  3: "Cold Store",
  4: "Reefer Truck",
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

export const unitLabel = (u: { kind: string; id: number; containerCode: string }) =>
  u.kind === "container" ? `Container ${u.containerCode}` : `Batch #${u.id}`;

/** The handover that closes each stage: "<from> → <to>". */
export const HANDOVER_NAMES: Record<number, string> = {
  0: "Supplier → Cargo",
  1: "Cargo → Destination Freight Handler",
  2: "Destination Freight Handler → Cold Store",
  3: "Cold Store → Reefer Truck",
  4: "Reefer Truck → Buyer",
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
export function whereIs(u: { kind: string; stage: string; containerCode: string; container?: { stage: string; splitAt: number | null } }) {
  if (u.kind === "batch" && u.stage === "Origin" && u.container) {
    const where = u.container.splitAt ? "split" : STAGE_LABELS[u.container.stage];
    return `In container ${u.containerCode} · ${where[0].toLowerCase()}${where.slice(1)}`; // "with Destination Freight Handler"
  }
  return STAGE_LABELS[u.stage];
}

/**
 * Why a typed container number would be rejected on-chain, or null if it's fine. Mirrors
 * ShipmentCustody.isValidContainerCode (ISO 6346: owner code, "U", six digits, check digit).
 */
export function containerNumberProblem(code: string): string | null {
  if (!/^[A-Z]{3}U\d{7}$/.test(code)) return "Use 3 letters, U, then 7 digits, e.g. MSKU9070323.";
  if (code.startsWith("CCS")) return "Owner code CCS is kept for generated numbers.";
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    let value = Number(code[i]);
    if (/[A-Z]/.test(code[i])) {
      // Letters are worth 10-38, skipping multiples of 11.
      value = code.charCodeAt(i) - 65 + 10;
      for (const skip of [11, 22, 33]) if (value >= skip) value++;
    }
    sum += value * 2 ** i;
  }
  return (sum % 11) % 10 === Number(code[10]) ? null : "The check digit (last digit) doesn't match. Check for a typo.";
}
