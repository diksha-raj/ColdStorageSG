import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useParticipants } from "../lib/participants";
import { ROLE_LABELS, type Role, shortAddress } from "../lib/format";

export function Card({
  title,
  subtitle,
  action,
  children,
  className = "",
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-line bg-white p-5 shadow-sm sm:p-6 ${className}`}>
      {(title || action) && (
        <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-base font-semibold">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

const BUTTON_STYLES = {
  primary: "bg-brand text-white hover:bg-brand-dark disabled:bg-brand/50",
  secondary: "border border-line bg-white text-ink hover:bg-canvas disabled:text-muted",
  danger: "bg-fail text-white hover:bg-fail/90 disabled:bg-fail/50",
  ghost: "text-brand-dark hover:bg-brand-soft",
};

export function Button({
  variant = "primary",
  busy,
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof BUTTON_STYLES; busy?: boolean }) {
  return (
    <button
      {...props}
      disabled={props.disabled || busy}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed ${BUTTON_STYLES[variant]} ${className}`}
    >
      {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

const TONES = {
  pass: "bg-pass-soft text-pass",
  warn: "bg-warn-soft text-warn",
  fail: "bg-fail-soft text-fail",
  brand: "bg-brand-soft text-brand-dark",
  neutral: "bg-slate-100 text-slate-600",
};
export type Tone = keyof typeof TONES;

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONES[tone]}`}>
      {children}
    </span>
  );
}

/** One place that maps every status in the app to the brief's colour rules. */
const STATUS: Record<string, { tone: Tone; label: string }> = {
  pass: { tone: "pass", label: "Pass" },
  clean: { tone: "pass", label: "Clean" },
  Verified: { tone: "pass", label: "Evidence verified" },
  resolved: { tone: "pass", label: "Resolved" },
  approved: { tone: "pass", label: "Approved" },
  acknowledged: { tone: "pass", label: "Closed" },
  released: { tone: "pass", label: "Released for sale" },
  rejected: { tone: "fail", label: "Rejected by QA" },
  flagged: { tone: "warn", label: "Flagged" },
  open: { tone: "warn", label: "Open claim" },
  pending: { tone: "warn", label: "Pending" },
  awaiting: { tone: "warn", label: "Awaiting evidence" },
  "awaiting-upload": { tone: "warn", label: "Awaiting log upload" },
  EvidenceMismatch: { tone: "fail", label: "Hash mismatch" },
  breach: { tone: "fail", label: "Breach" },
  upheld: { tone: "fail", label: "Upheld" },
  overturned: { tone: "pass", label: "Overturned" },
  compensation_agreed: { tone: "warn", label: "Compensation agreed" },
  suspended: { tone: "fail", label: "Suspended" },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { tone: "neutral" as Tone, label: status };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function RoleBadge({ role }: { role: Role | null }) {
  return <Badge tone="brand">{role ? ROLE_LABELS[role] : "No role yet"}</Badge>;
}

/** Shows an organisation name for a wallet, with the short address underneath. */
export function Party({ wallet, inline }: { wallet?: string | null; inline?: boolean }) {
  const { get } = useParticipants();
  if (!wallet) return <span className="text-muted">—</span>;
  const p = get(wallet);
  if (inline) {
    return (
      <span title={wallet}>
        {p?.org_name ?? shortAddress(wallet)}
      </span>
    );
  }
  return (
    <span className="inline-flex flex-col leading-tight" title={wallet}>
      <span className="font-medium">{p?.org_name ?? "Unknown wallet"}</span>
      <span className="font-mono text-xs text-muted">{shortAddress(wallet)}</span>
    </span>
  );
}

export const inputClass =
  "w-full rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Notice({ tone, children }: { tone: "error" | "success" | "info"; children: ReactNode }) {
  const styles = {
    error: "border-fail/20 bg-fail-soft text-fail",
    success: "border-pass/20 bg-pass-soft text-pass",
    info: "border-brand/20 bg-brand-soft text-brand-dark",
  };
  const Icon = tone === "success" ? CheckCircle2 : CircleAlert;
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${styles[tone]}`}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div>{children}</div>
    </div>
  );
}

/** Error / success feedback for a useAction() result. */
export function ActionFeedback({ error, success }: { error: string | null; success?: string | null }) {
  if (error) return <Notice tone="error">{error}</Notice>;
  if (success) return <Notice tone="success">{success}</Notice>;
  return null;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-sm text-muted">{children}</p>;
}

export function Loading() {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-muted">
      <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-white p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, action }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
