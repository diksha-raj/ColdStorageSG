// Off-chain shipment details. Custody state (who holds what, since when) is read from
// the ShipmentCustody contract; this schema only stores descriptive metadata.
export const schemaSql = `
CREATE SCHEMA IF NOT EXISTS custody;

CREATE TABLE IF NOT EXISTS custody.containers (
  id              INTEGER PRIMARY KEY,   -- on-chain container id (opened by Cargo)
  mode            TEXT NOT NULL CHECK (mode IN ('air', 'sea')),
  voyage          TEXT NOT NULL,         -- flight or vessel/voyage number
  origin          TEXT NOT NULL,
  destination     TEXT NOT NULL,
  departure_date  DATE NOT NULL,
  tx_hash         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS custody.batches (
  id            INTEGER PRIMARY KEY,     -- on-chain batch id (created by the supplier)
  product       TEXT NOT NULL,
  quantity      NUMERIC NOT NULL,
  unit          TEXT NOT NULL,
  tx_hash       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// Quality checks recorded by custodians while they hold a shipment. They're sealed at handover:
// the snapshot's hash goes on-chain inside the signed check (ShipmentCustody.Check.notesHash).
export const qualitySchemaSql = `
CREATE TABLE IF NOT EXISTS custody.readings (
  id          SERIAL PRIMARY KEY,
  unit_id     INTEGER NOT NULL,
  stage       INTEGER NOT NULL,     -- the custodian's stage when recorded
  wallet      TEXT NOT NULL,
  taken_at    TIMESTAMPTZ NOT NULL,
  temp_c      NUMERIC(4,1) NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS custody.issues (
  id                      SERIAL PRIMARY KEY,
  unit_id                 INTEGER NOT NULL,
  stage                   INTEGER NOT NULL,
  wallet                  TEXT NOT NULL,
  category                TEXT NOT NULL,
  unrefrigerated_minutes  INTEGER NOT NULL DEFAULT 0,
  description             TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Exact JSON that was hashed; keccak256(body) equals the on-chain notesHash.
CREATE TABLE IF NOT EXISTS custody.sealed_notes (
  notes_hash  TEXT PRIMARY KEY,
  unit_id     INTEGER NOT NULL,
  stage       INTEGER NOT NULL,     -- the stage the handover closes
  direction   TEXT NOT NULL CHECK (direction IN ('out', 'in')),
  wallet      TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;
