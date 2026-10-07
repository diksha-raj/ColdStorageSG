// Off-chain identity data. Wallet + role + active status are on-chain in ParticipantRegistry;
// organisation names and contact details stay here.
export const schemaSql = `
CREATE SCHEMA IF NOT EXISTS identity;

CREATE TABLE IF NOT EXISTS identity.login_nonces (
  nonce       TEXT PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS identity.access_requests (
  id              SERIAL PRIMARY KEY,
  wallet          TEXT NOT NULL,
  org_name        TEXT NOT NULL,
  contact_email   TEXT NOT NULL,
  requested_role  TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at      TIMESTAMPTZ,
  tx_hash         TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_request_per_wallet
  ON identity.access_requests (wallet) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS identity.participants (
  wallet         TEXT PRIMARY KEY,
  org_name       TEXT NOT NULL,
  contact_email  TEXT NOT NULL,
  role           TEXT NOT NULL,
  active         BOOLEAN NOT NULL DEFAULT true,
  registered_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;
