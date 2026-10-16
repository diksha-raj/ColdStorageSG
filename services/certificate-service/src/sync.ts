// Keeps the certificate lifecycle moving. Every few seconds it looks at each open batch and
// does whatever is due next, for each of the five stages (0 origin ... 4 reefer truck):
//   stage flagged (by a handover check or the sensor log) without a claim -> openClaim
//   checkpoint done (and, for legs 1-4, a verified sensor log) but no LegPass -> issueLegPass
//   all five LegPasses but no final certificate -> issueFinalCertificate
// Claims open as soon as a handover is flagged, so QA sees problems while the batch is in transit.
// Each step is idempotent, so a restart or missed event never leaves a batch stuck.
import { contract, env, serviceSigner } from "@coldchainsg/common";

const STAGES = [0, 1, 2, 3, 4];
const NO_CERTIFICATE = 0n;

const read = () => ({
  custody: contract("ShipmentCustody"),
  certs: contract("CertificateRegistry"),
});
const asCertifier = () => contract("CertificateRegistry", serviceSigner(env.CERTIFIER_PRIVATE_KEY, "Certifier"));

export type SyncAction = { batchId: number; action: string; leg?: number; txHash: string };

let queue: Promise<unknown> = Promise.resolve();

/** Runs a fresh pass after any pass already in progress (passes never overlap). */
export function syncOnce(): Promise<SyncAction[]> {
  const pass = queue.then(runPass);
  queue = pass.catch(() => undefined);
  return pass;
}

async function runPass(): Promise<SyncAction[]> {
  const { custody, certs } = read();
  const actions: SyncAction[] = [];
  const send = async (batchId: number, action: string, leg: number | undefined, tx: any) => {
    await tx.wait();
    actions.push({ batchId, action, leg, txHash: tx.hash });
  };

  const nextId = Number(await custody.nextId());
  for (let id = 1; id < nextId; id++) {
    const unit = await custody.getUnit(id);
    if (Number(unit.kind) !== 2) continue; // batches only
    if (Number((await certs.acknowledgements(id)).acknowledgedAt) !== 0) continue; // closed

    let reported = 0;
    for (const stage of STAGES) {
      const { flags, checkpointDone, sensorDone } = await certs.stageFlags(id, stage);
      if (flags !== 0n && (await certs.claimOf(id, stage)) === 0n) {
        await send(id, "openClaim", stage, await asCertifier().openClaim(id, stage));
      }
      if ((await certs.legPassOf(id, stage)) === 0n) {
        if (!checkpointDone || !sensorDone) continue;
        await send(id, "issueLegPass", stage, await asCertifier().issueLegPass(id, stage));
      }
      reported++;
    }

    if (reported === STAGES.length && (await certs.getCertificate(id)).status === NO_CERTIFICATE) {
      await send(id, "issueFinalCertificate", undefined, await asCertifier().issueFinalCertificate(id));
    }
  }
  return actions;
}

/** Background loop. Errors are logged and retried on the next tick. */
export function startSyncLoop(intervalMs = 3000) {
  const tick = async () => {
    try {
      const actions = await syncOnce();
      for (const a of actions) console.log(`sync: batch ${a.batchId} ${a.action}${a.leg !== undefined ? ` stage ${a.leg}` : ""}`);
    } catch (err) {
      console.error("sync failed:", (err as Error).message);
    }
    setTimeout(tick, intervalMs);
  };
  tick();
}
