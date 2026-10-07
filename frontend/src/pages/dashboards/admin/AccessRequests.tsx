import { useState } from "react";
import { ActionFeedback, Button, Card, Empty, Loading, inputClass } from "../../../components/ui";
import { api } from "../../../lib/api";
import { REQUESTABLE_ROLES, ROLE_LABELS, type Role, shortAddress } from "../../../lib/format";
import { useAction, useApi } from "../../../lib/hooks";
import { useParticipants } from "../../../lib/participants";

type Request = { id: number; wallet: string; org_name: string; contact_email: string; requested_role: Role; created_at: string };

export function AccessRequests() {
  const { data, loading, reload } = useApi<Request[]>("identity", "/access-requests?status=pending", 4000);
  if (loading && !data) return <Loading />;
  return (
    <Card title="Pending access requests" subtitle="Approving registers the wallet and its role on-chain.">
      {!data?.length ? (
        <Empty>No pending requests.</Empty>
      ) : (
        <ul className="divide-y divide-line">
          {data.map((r) => (
            <RequestRow key={r.id} request={r} onDone={reload} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function RequestRow({ request, onDone }: { request: Request; onDone: () => void }) {
  const [role, setRole] = useState<Role>(request.requested_role);
  const action = useAction();
  const participants = useParticipants();
  const decide = (decision: "approve" | "reject") =>
    action.run(async () => {
      await api("identity", `/access-requests/${request.id}/${decision}`, { body: decision === "approve" ? { role } : {} });
      onDone();
      participants.reload();
    });

  return (
    <li className="flex flex-wrap items-center justify-between gap-4 py-4">
      <div>
        <div className="font-medium">{request.org_name}</div>
        <div className="text-sm text-muted">
          {request.contact_email} · <span className="font-mono">{shortAddress(request.wallet)}</span> · asked for{" "}
          {ROLE_LABELS[request.requested_role]}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select className={`${inputClass} w-auto`} value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role to assign">
          {REQUESTABLE_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
        <Button busy={action.busy} onClick={() => decide("approve")}>
          Approve
        </Button>
        <Button variant="secondary" disabled={action.busy} onClick={() => decide("reject")}>
          Reject
        </Button>
      </div>
      {action.error && (
        <div className="w-full">
          <ActionFeedback error={action.error} />
        </div>
      )}
    </li>
  );
}
