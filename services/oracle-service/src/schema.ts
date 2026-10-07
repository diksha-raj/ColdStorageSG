// Off-chain sensor data. The SensorOracle contract holds sensor registrations, the sensor's
// committed file hash, and the per-batch leg summary; raw logger files and readings stay here.
export const schemaSql = `
CREATE SCHEMA IF NOT EXISTS oracle;

CREATE TABLE IF NOT EXISTS oracle.sensors (
  sensor_id      TEXT PRIMARY KEY,
  device         TEXT NOT NULL,
  label          TEXT NOT NULL,
  tx_hash        TEXT NOT NULL,
  registered_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Demo stand-in for physical reality: what the sensor records on a leg (default: compliant).
-- The sensor commits this file's hash automatically when the leg ends.
CREATE TABLE IF NOT EXISTS oracle.leg_recordings (
  shipment_id  INTEGER NOT NULL,   -- the unit the leg is recorded on (container for legs 1-3)
  leg          INTEGER NOT NULL,
  recording    TEXT NOT NULL CHECK (recording IN ('compliant', 'breach')),
  PRIMARY KEY (shipment_id, leg)
);

-- Logger files uploaded by custodians (a leg may get another upload after a hash mismatch).
CREATE TABLE IF NOT EXISTS oracle.leg_uploads (
  id              SERIAL PRIMARY KEY,
  shipment_id     INTEGER NOT NULL,
  leg             INTEGER NOT NULL,
  uploaded_by     TEXT NOT NULL,
  file_name       TEXT NOT NULL,
  raw_file        BYTEA NOT NULL,      -- exact bytes, so anyone can re-hash them
  file_hash       TEXT NOT NULL,
  committed_hash  TEXT NOT NULL,
  readings        JSONB NOT NULL,      -- rebased [{at, tempC}] for evidence charts
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oracle.upload_results (
  id              SERIAL PRIMARY KEY,
  upload_id       INTEGER NOT NULL REFERENCES oracle.leg_uploads(id),
  batch_id        INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('Verified', 'EvidenceMismatch', 'AlreadyVerified')),
  threshold_c     NUMERIC NOT NULL,
  min_c           NUMERIC NOT NULL,
  max_c           NUMERIC NOT NULL,
  breach_minutes  INTEGER NOT NULL,
  tx_hash         TEXT
);
`;
