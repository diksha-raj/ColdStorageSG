// The sensor gateway's own records: the sensors it manages (and how each one reads), and every
// readings file it committed on-chain. The committed file is kept byte for byte, so anyone can
// re-hash it and compare with SensorOracle.committedHash.
export const schemaSql = `
CREATE SCHEMA IF NOT EXISTS gateway;

CREATE TABLE IF NOT EXISTS gateway.sensors (
  sensor_id      TEXT PRIMARY KEY,
  owner          TEXT NOT NULL,               -- the participant who registered it
  mode           TEXT NOT NULL CHECK (mode IN ('compliant', 'breached', 'feed')),
  label          TEXT NOT NULL,
  device         TEXT NOT NULL,               -- the device key's address, registered on-chain
  feed           JSONB,                       -- 'feed' only: one reading per minute
  registered_at  BIGINT NOT NULL,             -- unix seconds
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gateway.commits (
  unit_id       INTEGER NOT NULL,             -- container (stages 1-2) or batch
  stage         INTEGER NOT NULL,
  sensor_id     TEXT NOT NULL,
  start_at      BIGINT NOT NULL,
  end_at        BIGINT NOT NULL,
  csv           TEXT NOT NULL,
  file_hash     TEXT NOT NULL,
  tx_hash       TEXT NOT NULL,
  committed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (unit_id, stage)
);
`;
