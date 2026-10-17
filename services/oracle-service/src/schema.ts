// The oracle's own record of what it submitted. The readings themselves are the sensor
// gateway's; the summaries and their status live on-chain in SensorOracle.
export const schemaSql = `
CREATE SCHEMA IF NOT EXISTS oracle;

CREATE TABLE IF NOT EXISTS oracle.submissions (
  id              SERIAL PRIMARY KEY,
  batch_id        INTEGER NOT NULL,
  stage           INTEGER NOT NULL,
  file_hash       TEXT NOT NULL,         -- SHA-256 of the readings the oracle summarised
  status          TEXT NOT NULL CHECK (status IN ('Verified', 'EvidenceMismatch')),
  threshold_c     NUMERIC NOT NULL,
  max_c           NUMERIC NOT NULL,
  breach_minutes  INTEGER NOT NULL,
  missing_minutes INTEGER NOT NULL,
  tx_hash         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;
