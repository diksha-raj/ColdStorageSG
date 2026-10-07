// Leg passes, claims, resolutions, certificates and acknowledgements are all on-chain.
// Off-chain: inspection notes beyond the signed resolution note (e.g. what was checked on arrival).
export const schemaSql = `
CREATE SCHEMA IF NOT EXISTS certificate;

CREATE TABLE IF NOT EXISTS certificate.inspection_notes (
  id          SERIAL PRIMARY KEY,
  claim_id    INTEGER NOT NULL,
  author      TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;
