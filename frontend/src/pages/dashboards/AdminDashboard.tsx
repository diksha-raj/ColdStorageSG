import { Pause, Play } from "lucide-react";
import { useSearchParams } from "react-router";
import { Button, PageHeader } from "../../components/ui";
import { api } from "../../lib/api";
import { useAction, useApi } from "../../lib/hooks";
import { AccessRequests } from "./admin/AccessRequests";
import { AuditLog } from "./admin/AuditLog";
import { DemoControl } from "./admin/DemoControl";
import { Overview } from "./admin/Overview";
import { Participants } from "./admin/Participants";
import { Sensors } from "./admin/Sensors";

const TABS = [
  { id: "overview", label: "Overview", Component: Overview },
  { id: "requests", label: "Access requests", Component: AccessRequests },
  { id: "participants", label: "Participants", Component: Participants },
  { id: "sensors", label: "Sensors", Component: Sensors },
  { id: "demo", label: "Demo control", Component: DemoControl },
  { id: "audit", label: "Audit log", Component: AuditLog },
] as const;

export function AdminDashboard() {
  const [params, setParams] = useSearchParams();
  const active = TABS.find((t) => t.id === params.get("tab")) ?? TABS[0];

  return (
    <div>
      <PageHeader title="Platform admin" subtitle="Onboard participants, register sensors, drive the demo, and watch the evidence trail." action={<PauseToggle />} />
      <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-line" aria-label="Admin sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setParams({ tab: t.id })}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${
              t.id === active.id ? "border-brand text-brand-dark" : "border-transparent text-muted hover:text-ink"
            }`}
            aria-current={t.id === active.id ? "page" : undefined}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <active.Component />
    </div>
  );
}

function PauseToggle() {
  const { data, reload } = useApi<{ paused: boolean }>("identity", "/system", 5000);
  const toggle = useAction();
  if (!data) return null;
  return (
    <div className="text-right">
      <Button
        variant={data.paused ? "primary" : "secondary"}
        busy={toggle.busy}
        onClick={() =>
          toggle.run(async () => {
            if (!data.paused && !window.confirm("Pause the whole system? All on-chain actions will be blocked.")) return;
            await api("identity", `/system/${data.paused ? "unpause" : "pause"}`, { body: {} });
            await reload();
          })
        }
      >
        {data.paused ? <Play className="size-4" aria-hidden /> : <Pause className="size-4" aria-hidden />}
        {data.paused ? "Resume system" : "Pause system"}
      </Button>
      {toggle.error && <p className="mt-1 text-xs text-fail">{toggle.error}</p>}
    </div>
  );
}
