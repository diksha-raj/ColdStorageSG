// A claim: the evidence for the flagged stage, who held the batch, and the inspector's
// signed resolution. Resolutions record an outcome only; any settlement happens off-platform.
import { ArrowLeft, PenLine } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Link, useParams } from "react-router";
import { useAuth } from "../auth";
import { CertificatePanel } from "../components/CertificatePanel";
import { CheckpointTimeline } from "../components/CheckpointTimeline";
import { LegEvidence } from "../components/LegEvidence";
import { ActionFeedback, Badge, Button, Card, Field, Loading, Notice, PageHeader, Party, StatusBadge, inputClass } from "../components/ui";
import { api } from "../lib/api";
import { sendTx } from "../lib/chain";
import { HANDOVER_NAMES, LEG_NAMES, REASON_LABELS, formatTime, sameAddress } from "../lib/format";
import { useAction, useApi } from "../lib/hooks";
import type { Claim, Outcome, ShipmentDetail } from "../lib/types";

const OUTCOMES: { value: Outcome; index: number; label: string; description: string }[] = [
  { value: "upheld", index: 0, label: "Upheld", description: "The problem happened on this stage and its holder is responsible." },
  { value: "overturned", index: 1, label: "Overturned", description: "The evidence doesn't hold up, e.g. a misplaced probe. The claim is dismissed." },
  {
    value: "compensation_agreed",
    index: 2,
    label: "Compensation agreed",
    description: "The parties have agreed a settlement between themselves, off-platform.",
  },
];

export function ClaimPage() {
  const { id } = useParams();
  const { session } = useAuth();
  const { data: claim, error, reload } = useApi<Claim>("certificate", `/claims/${id}`, 5000);
  const { data: batch } = useApi<ShipmentDetail>("custody", claim ? `/shipments/${claim.batchId}` : null);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!claim || !batch) return <Loading />;

  const isInspector = sameAddress(session?.wallet, batch.inspector);
  const canNote = isInspector || sameAddress(session?.wallet, batch.buyer);

  return (
    <div className="space-y-6">
      <Link to="/app" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden /> Dashboard
      </Link>
      <PageHeader
        title={`Claim #${claim.id} · Stage ${claim.leg}, ${LEG_NAMES[claim.leg]}`}
        subtitle={
          <>
            <Link className="underline" to={`/shipments/${batch.id}`}>
              Batch #{batch.id} · {batch.details?.product ?? "batch"}
            </Link>{" "}
            · opened {formatTime(claim.openedAt)}
          </>
        }
        action={<StatusBadge status={claim.resolution?.outcome ?? claim.status} />}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Why it was flagged" className="lg:col-span-1">
          <div className="flex flex-wrap gap-1">
            {claim.reasons.map((r) => (
              <Badge key={r} tone="fail">
                {REASON_LABELS[r]}
              </Badge>
            ))}
          </div>
          <div className="mt-4 text-sm">
            <span className="text-muted">Held the batch on this stage: </span>
            <Party wallet={claim.provisionalCustodian} />
          </div>
          <p className="mt-3 text-sm text-muted">
            Provisionally responsible. Your ruling decides the outcome; any settlement happens between the firms, off-platform.
          </p>
        </Card>
        <div className="lg:col-span-2">
          {claim.resolution ? (
            <Card title="Resolution" subtitle={`Signed on-chain ${formatTime(claim.resolution.signedAt)}`} action={<StatusBadge status={claim.resolution.outcome} />}>
              <blockquote className="border-l-2 border-brand pl-4 text-sm">{claim.resolution.note}</blockquote>
              <div className="mt-4 text-sm">
                <span className="text-muted">Inspector: </span>
                <Party wallet={claim.resolution.inspector} inline />
              </div>
            </Card>
          ) : isInspector ? (
            <ResolutionForm claimId={claim.id} onDone={reload} />
          ) : (
            <Card title="Resolution">
              <p className="text-sm text-muted">
                Waiting for the batch's quality inspector, <Party wallet={batch.inspector} inline />, to review the evidence.
              </p>
            </Card>
          )}
        </div>
      </div>

      <CheckpointTimeline
        title={`Handover check: ${HANDOVER_NAMES[claim.leg]}`}
        checkpoints={batch.checkpoints.filter((cp) => cp.stage === claim.leg)}
        stages={[{ stage: claim.leg, reasons: claim.reasons, checkpointDone: true, sensorDone: true }]}
        totalStages={1}
        showSummary={false}
      />
      <LegEvidence batchId={claim.batchId} onlyLeg={claim.leg} />
      <CertificatePanel batchId={claim.batchId} buyer={batch.buyer} inspector={batch.inspector} />
      <InspectionNotes claim={claim} canAdd={canNote} onAdded={reload} />
    </div>
  );
}

function ResolutionForm({ claimId, onDone }: { claimId: number; onDone: () => void }) {
  const [outcome, setOutcome] = useState<Outcome>("upheld");
  const [note, setNote] = useState("");
  const submit = useAction();
  const noteBytes = new TextEncoder().encode(note).length;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const index = OUTCOMES.find((o) => o.value === outcome)!.index;
    submit.run(async () => {
      await sendTx("CertificateRegistry", "submitResolution", [claimId, index, note.trim()]);
      onDone();
    });
  };

  return (
    <Card title="Submit your resolution" subtitle="Signed with your wallet and recorded on-chain. It can't be changed afterwards.">
      <form onSubmit={onSubmit} className="space-y-4">
        <fieldset className="grid gap-2 sm:grid-cols-3">
          <legend className="sr-only">Outcome</legend>
          {OUTCOMES.map((o) => (
            <label
              key={o.value}
              className={`cursor-pointer rounded-xl border p-3 text-sm ${outcome === o.value ? "border-brand bg-brand-soft" : "border-line"}`}
            >
              <input type="radio" name="outcome" value={o.value} checked={outcome === o.value} onChange={() => setOutcome(o.value)} className="sr-only" />
              <span className="font-medium">{o.label}</span>
              <span className="mt-1 block text-xs text-muted">{o.description}</span>
            </label>
          ))}
        </fieldset>
        <Field label="Resolution note" hint={`${noteBytes} / 1000 bytes. Stored on-chain.`}>
          <textarea className={`${inputClass} min-h-24`} value={note} onChange={(e) => setNote(e.target.value)} required />
        </Field>
        <ActionFeedback error={submit.error} />
        <Button type="submit" busy={submit.busy} disabled={!note.trim() || noteBytes > 1000}>
          <PenLine className="size-4" aria-hidden /> Sign and submit resolution
        </Button>
      </form>
    </Card>
  );
}

function InspectionNotes({ claim, canAdd, onAdded }: { claim: Claim; canAdd: boolean; onAdded: () => void }) {
  const [body, setBody] = useState("");
  const add = useAction();

  return (
    <Card title="Inspection notes" subtitle="Working notes kept off-chain, separate from the signed resolution.">
      {claim.inspectionNotes.length === 0 ? (
        <p className="text-sm text-muted">No notes yet.</p>
      ) : (
        <ul className="space-y-3">
          {claim.inspectionNotes.map((n, i) => (
            <li key={i} className="rounded-lg bg-canvas px-3 py-2 text-sm">
              <p>{n.body}</p>
              <p className="mt-1 text-xs text-muted">
                <Party wallet={n.author} inline /> · {new Date(n.created_at).toLocaleString("en-SG")}
              </p>
            </li>
          ))}
        </ul>
      )}
      {canAdd && (
        <form
          className="mt-4 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add.run(async () => {
              await api("certificate", `/claims/${claim.id}/notes`, { body: { body } });
              setBody("");
              onAdded();
            });
          }}
        >
          <input className={`${inputClass} flex-1`} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a note…" required maxLength={2000} />
          <Button type="submit" variant="secondary" busy={add.busy}>
            Add note
          </Button>
          <div className="w-full">
            <ActionFeedback error={add.error} />
          </div>
        </form>
      )}
    </Card>
  );
}
