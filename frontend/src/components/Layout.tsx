import { LogOut, PauseCircle, Snowflake } from "lucide-react";
import { Link, Outlet } from "react-router";
import { useAuth } from "../auth";
import { shortAddress } from "../lib/format";
import { useApi } from "../lib/hooks";
import { ParticipantsProvider } from "../lib/participants";
import { RoleBadge } from "./ui";

export function Logo() {
  return (
    <span className="inline-flex items-center gap-2 font-semibold tracking-tight">
      <span className="grid size-8 place-items-center rounded-lg bg-brand text-white">
        <Snowflake className="size-4.5" aria-hidden />
      </span>
      ColdChainSG
    </span>
  );
}

/** Signed-in shell: header with org, role and wallet, plus a banner while the system is paused. */
export function AppLayout() {
  const { session, signOut } = useAuth();
  const { data: system } = useApi<{ paused: boolean }>("identity", "/system", 5000);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-line bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <Link to="/app" aria-label="Dashboard">
            <Logo />
          </Link>
          {session && (
            <div className="flex items-center gap-3 text-sm">
              <div className="hidden text-right leading-tight sm:block">
                <div className="font-medium">{session.profile?.org_name ?? (session.role === "ADMIN" ? "Platform admin" : "Guest")}</div>
                <div className="font-mono text-xs text-muted">{shortAddress(session.wallet)}</div>
              </div>
              <RoleBadge role={session.role} />
              <button
                onClick={signOut}
                className="rounded-lg p-2 text-muted hover:bg-canvas hover:text-ink"
                aria-label="Sign out"
                title="Sign out"
              >
                <LogOut className="size-4" />
              </button>
            </div>
          )}
        </div>
        {system?.paused && (
          <div className="flex items-center justify-center gap-2 bg-warn-soft px-4 py-2 text-sm font-medium text-warn">
            <PauseCircle className="size-4" aria-hidden /> The system is paused by the admin. On-chain actions are blocked
            until it resumes.
          </div>
        )}
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <ParticipantsProvider>
          <Outlet />
        </ParticipantsProvider>
      </main>
    </div>
  );
}
