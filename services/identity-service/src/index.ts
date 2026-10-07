import {
  type AuthedRequest,
  HttpError,
  PARTICIPANT_ROLES,
  contract,
  createApp,
  db,
  env,
  getDeployment,
  lookupRole,
  migrate,
  requireAuth,
  requireRole,
  roleHash,
  serviceSigner,
  signSession,
  start,
  z,
} from "@coldchainsg/common";
import { getAddress } from "ethers";
import { SiweMessage, generateNonce } from "siwe";
import { schemaSql } from "./schema.ts";

await migrate(schemaSql);

const app = createApp();
const frontendHost = new URL(env.FRONTEND_ORIGIN).host;
const NONCE_TTL_MINUTES = 10;

const registry = () => contract("ParticipantRegistry");
const adminRegistry = () => contract("ParticipantRegistry", serviceSigner(env.ADMIN_PRIVATE_KEY, "Admin"));

const walletSchema = z.string().transform((value, ctx) => {
  try {
    return getAddress(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "Not a valid wallet address" });
    return z.NEVER;
  }
});
const participantRole = z.enum(PARTICIPANT_ROLES);

// ---- Frontend config ---------------------------------------------------------

/** Contract addresses + ABIs, so the frontend never needs rebuilding after a redeploy. */
app.get("/config", (_req, res) => {
  const { chainId, contracts } = getDeployment();
  res.json({ chainId, rpcUrl: env.RPC_URL, contracts });
});

// ---- Sign-In with Ethereum --------------------------------------------------

app.get("/auth/nonce", async (_req, res) => {
  const nonce = generateNonce();
  await db.query("INSERT INTO identity.login_nonces (nonce) VALUES ($1)", [nonce]);
  res.json({ nonce, chainId: getDeployment().chainId, domain: frontendHost });
});

app.post("/auth/verify", async (req, res) => {
  const { message, signature } = z.object({ message: z.string().max(2000), signature: z.string() }).parse(req.body);

  let siwe: SiweMessage;
  try {
    siwe = new SiweMessage(message);
  } catch {
    throw new HttpError(400, "Malformed sign-in message");
  }

  // Each nonce can be used once, within NONCE_TTL_MINUTES of being issued.
  const claimed = await db.query(
    `UPDATE identity.login_nonces SET used_at = now()
     WHERE nonce = $1 AND used_at IS NULL AND created_at > now() - make_interval(mins => $2)
     RETURNING nonce`,
    [siwe.nonce, NONCE_TTL_MINUTES],
  );
  if (claimed.rowCount !== 1) throw new HttpError(401, "Sign-in nonce is invalid or expired");

  const result = await siwe.verify({ signature, domain: frontendHost, nonce: siwe.nonce }, { suppressExceptions: true });
  if (!result.success) throw new HttpError(401, "Signature verification failed");
  if (siwe.chainId !== getDeployment().chainId) throw new HttpError(401, "Wrong chain");

  const wallet = getAddress(siwe.address);
  res.json({ token: signSession(wallet), wallet, role: await lookupRole(wallet) });
});

app.get("/me", requireAuth, async (req, res) => {
  const { wallet, role } = req as AuthedRequest;
  const profile = await db.query("SELECT org_name, contact_email FROM identity.participants WHERE wallet = $1", [
    wallet,
  ]);
  const request = await db.query(
    "SELECT id, status, requested_role, created_at FROM identity.access_requests WHERE wallet = $1 ORDER BY id DESC LIMIT 1",
    [wallet],
  );
  res.json({ wallet, role, profile: profile.rows[0] ?? null, latestRequest: request.rows[0] ?? null });
});

// ---- Access requests ---------------------------------------------------------

app.post("/access-requests", requireAuth, async (req, res) => {
  const { wallet, role } = req as AuthedRequest;
  if (role) throw new HttpError(409, "This wallet is already registered");

  const body = z
    .object({
      orgName: z.string().trim().min(2).max(120),
      contactEmail: z.email().max(200),
      requestedRole: participantRole,
    })
    .parse(req.body);

  try {
    const { rows } = await db.query(
      `INSERT INTO identity.access_requests (wallet, org_name, contact_email, requested_role)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [wallet, body.orgName, body.contactEmail, body.requestedRole],
    );
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.code === "23505") throw new HttpError(409, "You already have a pending request");
    throw err;
  }
});

app.get("/access-requests", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const status = z.enum(["pending", "approved", "rejected"]).default("pending").parse(req.query.status);
  const { rows } = await db.query("SELECT * FROM identity.access_requests WHERE status = $1 ORDER BY id", [status]);
  res.json(rows);
});

app.post("/access-requests/:id/approve", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  // The admin may assign a different role than the one requested.
  const { role } = z.object({ role: participantRole.optional() }).parse(req.body ?? {});

  const { rows } = await db.query("SELECT * FROM identity.access_requests WHERE id = $1 AND status = 'pending'", [id]);
  const request = rows[0];
  if (!request) throw new HttpError(404, "No pending request with that id");
  const assignedRole = role ?? request.requested_role;

  const tx = await adminRegistry().registerParticipant(request.wallet, roleHash(assignedRole));
  await tx.wait();

  await db.query(
    "UPDATE identity.access_requests SET status = 'approved', decided_at = now(), tx_hash = $2 WHERE id = $1",
    [id, tx.hash],
  );
  await db.query(
    `INSERT INTO identity.participants (wallet, org_name, contact_email, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (wallet) DO UPDATE SET org_name = $2, contact_email = $3, role = $4, active = true`,
    [request.wallet, request.org_name, request.contact_email, assignedRole],
  );
  res.json({ wallet: request.wallet, role: assignedRole, txHash: tx.hash });
});

app.post("/access-requests/:id/reject", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const { rowCount } = await db.query(
    "UPDATE identity.access_requests SET status = 'rejected', decided_at = now() WHERE id = $1 AND status = 'pending'",
    [id],
  );
  if (rowCount !== 1) throw new HttpError(404, "No pending request with that id");
  res.json({ id, status: "rejected" });
});

// ---- Participants ------------------------------------------------------------

// Any signed-in user can list participants (e.g. the importer picks a buyer and inspector).
app.get("/participants", requireAuth, async (req, res) => {
  const role = participantRole.optional().parse(req.query.role);
  const { rows } = role
    ? await db.query("SELECT * FROM identity.participants WHERE role = $1 AND active ORDER BY org_name", [role])
    : await db.query("SELECT * FROM identity.participants ORDER BY role, org_name");
  res.json(rows);
});

app.post("/participants/:wallet/suspend", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const wallet = walletSchema.parse(req.params.wallet);
  const tx = await adminRegistry().suspendParticipant(wallet);
  await tx.wait();
  await db.query("UPDATE identity.participants SET active = false WHERE wallet = $1", [wallet]);
  res.json({ wallet, active: false, txHash: tx.hash });
});

// ---- System pause ------------------------------------------------------------

app.get("/system", async (_req, res) => {
  res.json({ paused: await registry().paused() });
});

app.post("/system/:action", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const action = z.enum(["pause", "unpause"]).parse(req.params.action);
  const tx = await adminRegistry()[action]();
  await tx.wait();
  res.json({ paused: action === "pause", txHash: tx.hash });
});

start(app, "identity-service", env.IDENTITY_PORT);
