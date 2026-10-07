// Every platform event, read straight from the four contracts.
import { Card, Empty, Loading, Party } from "../../../components/ui";
import { formatTime, shortHash } from "../../../lib/format";
import { useApi } from "../../../lib/hooks";

type AuditEvent = { contract: string; event: string; args: Record<string, unknown>; block: number; txHash: string; at: number };

const isAddress = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

export function AuditLog() {
  const { data, loading } = useApi<AuditEvent[]>("certificate", "/audit?limit=200", 6000);
  if (loading && !data) return <Loading />;

  return (
    <Card title="Audit log" subtitle="Latest 200 on-chain events across all four contracts, newest first.">
      {!data?.length ? (
        <Empty>No events yet.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="py-2 pr-4 font-medium">When</th>
                <th className="py-2 pr-4 font-medium">Event</th>
                <th className="py-2 pr-4 font-medium">Details</th>
                <th className="py-2 font-medium">Tx</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line align-top">
              {data.map((e) => (
                <tr key={`${e.txHash}-${e.event}-${JSON.stringify(e.args)}`}>
                  <td className="whitespace-nowrap py-2 pr-4 text-muted">{formatTime(e.at)}</td>
                  <td className="py-2 pr-4">
                    <div className="font-medium">{e.event}</div>
                    <div className="text-xs text-muted">{e.contract}</div>
                  </td>
                  <td className="py-2 pr-4">
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      {Object.entries(e.args).map(([k, v]) => (
                        <span key={k}>
                          <span className="text-muted">{k}: </span>
                          {isAddress(v) ? <Party wallet={v} inline /> : <span className="font-mono text-xs">{formatArg(v)}</span>}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="py-2 font-mono text-xs text-muted">{shortHash(e.txHash)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function formatArg(v: unknown) {
  if (typeof v === "string" && v.startsWith("0x") && v.length === 66) return shortHash(v);
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}
