import { ActionFeedback, Button, Card, Empty, StatusBadge } from "../../../components/ui";
import { api } from "../../../lib/api";
import { ROLE_LABELS, shortAddress } from "../../../lib/format";
import { useAction } from "../../../lib/hooks";
import { useParticipants } from "../../../lib/participants";

export function Participants() {
  const { list, reload } = useParticipants();
  const suspend = useAction();

  return (
    <Card title="Participants" subtitle="Wallet and role live on-chain; organisation details are kept off-chain.">
      {list.length === 0 ? (
        <Empty>No participants yet. Approve an access request to add one.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="py-2 pr-4 font-medium">Organisation</th>
                <th className="py-2 pr-4 font-medium">Role</th>
                <th className="py-2 pr-4 font-medium">Wallet</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.map((p) => (
                <tr key={p.wallet}>
                  <td className="py-3 pr-4">
                    <div className="font-medium">{p.org_name}</div>
                    <div className="text-xs text-muted">{p.contact_email}</div>
                  </td>
                  <td className="py-3 pr-4">{ROLE_LABELS[p.role]}</td>
                  <td className="py-3 pr-4 font-mono text-xs">{shortAddress(p.wallet)}</td>
                  <td className="py-3 pr-4">
                    <StatusBadge status={p.active ? "approved" : "suspended"} />
                  </td>
                  <td className="py-3 text-right">
                    {p.active && (
                      <Button
                        variant="secondary"
                        disabled={suspend.busy}
                        onClick={() =>
                          window.confirm(`Suspend ${p.org_name}? They will lose their role on-chain immediately.`) &&
                          suspend.run(async () => {
                            await api("identity", `/participants/${p.wallet}/suspend`, { body: {} });
                            await reload();
                          })
                        }
                      >
                        Suspend
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-3">
        <ActionFeedback error={suspend.error} />
      </div>
    </Card>
  );
}
