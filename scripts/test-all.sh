#!/usr/bin/env bash
# Runs every test suite against an ISOLATED stack, so the demo stack is never touched:
#
#   chain  :8546   database coldchainsg_e2e   services :4101-4105   web :5174
#
# Usage: npm run test:all        (Postgres must be running; nothing else needs to be)
set -uo pipefail
cd "$(dirname "$0")/.."

LOGS="${LOGS:-$(mktemp -d)}"
PORTS=(8546 4101 4102 4103 4104 4105 5174)
export CHAIN_NETWORK=e2e RPC_URL=http://127.0.0.1:8546
export DATABASE_URL=postgres://localhost:5433/coldchainsg_e2e
export IDENTITY_PORT=4101 CUSTODY_PORT=4102 ORACLE_PORT=4103 CERTIFICATE_PORT=4104 GATEWAY_PORT=4105
export FRONTEND_ORIGIN=http://localhost:5174 E2E_WEB_URL=http://localhost:5174
export VITE_IDENTITY_URL=http://localhost:4101 VITE_CUSTODY_URL=http://localhost:4102
export VITE_ORACLE_URL=http://localhost:4103 VITE_CERTIFICATE_URL=http://localhost:4104 VITE_GATEWAY_URL=http://localhost:4105
export SCREENSHOT_DIR="${SCREENSHOT_DIR:-$PWD/frontend/e2e/screenshots}"

stop_stack() { for p in "${PORTS[@]}"; do lsof -tiTCP:"$p" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null; done; }
pause() { perl -e "select(undef,undef,undef,$1)"; }
wait_for() {
  for _ in $(seq 1 120); do curl -sf "$1" >/dev/null 2>&1 && return 0; pause 0.5; done
  echo "Timed out waiting for $1 (logs in $LOGS)"; exit 1
}
trap stop_stack EXIT

for p in "${PORTS[@]}"; do
  if lsof -tiTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then echo "Port $p is busy; stop whatever is using it first."; exit 1; fi
done

echo "Logs: $LOGS"
echo "▶ Starting isolated stack…"
node -e "
  const { Client } = require('pg');
  const c = new Client({ connectionString: process.env.DATABASE_URL.replace(/\/[^/]+$/, '/postgres') });
  c.connect().then(() => c.query('CREATE DATABASE coldchainsg_e2e'))
    .catch((e) => { if (e.code !== '42P04') { console.error(e.message); process.exit(1); } })
    .finally(() => c.end());
" || exit 1

(cd contracts && npx hardhat node --port 8546 > "$LOGS/chain.log" 2>&1) & disown
for _ in $(seq 1 120); do
  curl -sf -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"}' http://127.0.0.1:8546 >/dev/null && break
  pause 0.5
done
(cd contracts && npx hardhat run scripts/deploy.ts --network e2e > "$LOGS/deploy.log" 2>&1) || { echo "Deploy failed: $LOGS/deploy.log"; exit 1; }
npx tsx services/common/scripts/reset-db.ts >> "$LOGS/deploy.log" 2>&1

for s in identity-service custody-service oracle-service certificate-service sensor-gateway; do npm start -w "services/$s" > "$LOGS/${s%-service}.log" 2>&1 & disown; done
(cd frontend && npx vite --port 5174 --strictPort > "$LOGS/web.log" 2>&1) & disown
for port in 4101 4102 4103 4104 4105; do wait_for "http://localhost:$port/health"; done
wait_for http://localhost:5174
npx tsx services/common/scripts/seed-demo.ts > "$LOGS/seed.log" 2>&1 || { echo "Seed failed: $LOGS/seed.log"; exit 1; }

FAILED=0
run() {
  local name=$1; shift
  # "test-" prefix: the service logs (identity.log, …) live in the same folder.
  local log="$LOGS/test-$name.log"
  if "$@" > "$log" 2>&1; then
    echo "✔ $name  $(grep -ahoE '[0-9]+ passing|ℹ pass [0-9]+' "$log" | tail -1)"
  else
    echo "✖ $name  (see $log)"; FAILED=1
  fi
}

# The browser test expects a fresh chain (its batches are #1 and #2), so it runs first.
run browser      npx tsx --test --test-concurrency=1 frontend/e2e/demo.e2e.ts
run contracts    npm test -w contracts
run identity     npm test -w services/identity-service
run custody      npm test -w services/custody-service
run oracle       npm test -w services/oracle-service
run certificate  npm test -w services/certificate-service
run gateway      npm test -w services/sensor-gateway

exit $FAILED
