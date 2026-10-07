// Connect MetaMask → sign a one-time message → known wallets go to their dashboard;
// unknown wallets fill in a short access request for the admin to approve.
import { Clock, Wallet } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { useAuth } from "../auth";
import { Logo } from "../components/Layout";
import { ActionFeedback, Button, Card, Field, Notice, inputClass } from "../components/ui";
import { api } from "../lib/api";
import { hasWallet } from "../lib/chain";
import { REQUESTABLE_ROLES, ROLE_LABELS, type Role, shortAddress } from "../lib/format";
import { useAction } from "../lib/hooks";

export function Login() {
  const { session, signIn, signOut, refresh } = useAuth();
  const navigate = useNavigate();
  const connect = useAction();

  // While a request is pending, check every few seconds whether the admin has approved it.
  const pending = session?.latestRequest?.status === "pending";
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, [pending, refresh]);

  if (session?.role) return <Navigate to="/app" replace />;

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-12">
      <div className="mb-8 flex justify-center">
        <Logo />
      </div>

      {!session && (
        <Card>
          <h1 className="text-xl font-semibold">Sign in with your wallet</h1>
          <p className="mt-2 text-sm text-muted">
            You'll be asked to sign a one-time message in MetaMask. Signing is free and doesn't send a transaction.
          </p>
          {!hasWallet() && (
            <div className="mt-4">
              <Notice tone="error">
                MetaMask wasn't found in this browser. Install it from metamask.io, then reload this page.
              </Notice>
            </div>
          )}
          <Button
            className="mt-6 w-full"
            busy={connect.busy}
            disabled={!hasWallet()}
            onClick={() =>
              connect.run(async () => {
                const me = await signIn();
                if (me.role) navigate("/app");
              })
            }
          >
            <Wallet className="size-4" aria-hidden /> {connect.busy ? "Check MetaMask…" : "Connect wallet"}
          </Button>
          <div className="mt-4">
            <ActionFeedback error={connect.error} />
          </div>
        </Card>
      )}

      {session && !session.role && pending && (
        <Card>
          <div className="flex items-center gap-2 text-warn">
            <Clock className="size-5" aria-hidden />
            <h1 className="text-lg font-semibold text-ink">Waiting for approval</h1>
          </div>
          <p className="mt-2 text-sm text-muted">
            Your request to join as <strong>{ROLE_LABELS[session.latestRequest!.requested_role]}</strong> has been sent to
            the platform admin. This page will update as soon as it's approved.
          </p>
          <WalletLine wallet={session.wallet} onSignOut={signOut} />
        </Card>
      )}

      {session && !session.role && !pending && (
        <RequestAccess
          wallet={session.wallet}
          rejected={session.latestRequest?.status === "rejected"}
          onSubmitted={refresh}
          onSignOut={signOut}
        />
      )}
    </div>
  );
}

function RequestAccess({
  wallet,
  rejected,
  onSubmitted,
  onSignOut,
}: {
  wallet: string;
  rejected: boolean;
  onSubmitted: () => Promise<void>;
  onSignOut: () => void;
}) {
  const [orgName, setOrgName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [requestedRole, setRequestedRole] = useState<Role>("BUYER");
  const submit = useAction();

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.run(async () => {
      await api("identity", "/access-requests", { body: { orgName, contactEmail, requestedRole } });
      await onSubmitted();
    });
  };

  return (
    <Card>
      <h1 className="text-xl font-semibold">Request access</h1>
      <p className="mt-2 text-sm text-muted">
        This wallet isn't registered yet. Tell us who you are and the admin will review your request.
      </p>
      {rejected && (
        <div className="mt-4">
          <Notice tone="error">Your previous request was declined. You can submit a new one.</Notice>
        </div>
      )}
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <Field label="Organisation name">
          <input className={inputClass} value={orgName} onChange={(e) => setOrgName(e.target.value)} required minLength={2} />
        </Field>
        <Field label="Contact email">
          <input
            className={inputClass}
            type="email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            required
          />
        </Field>
        <Field label="Your role in the cold chain">
          <select className={inputClass} value={requestedRole} onChange={(e) => setRequestedRole(e.target.value as Role)}>
            {REQUESTABLE_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </Field>
        <ActionFeedback error={submit.error} />
        <Button type="submit" className="w-full" busy={submit.busy}>
          Send request
        </Button>
      </form>
      <WalletLine wallet={wallet} onSignOut={onSignOut} />
    </Card>
  );
}

function WalletLine({ wallet, onSignOut }: { wallet: string; onSignOut: () => void }) {
  return (
    <p className="mt-6 border-t border-line pt-4 text-xs text-muted">
      Signed in as <span className="font-mono">{shortAddress(wallet)}</span> ·{" "}
      <button className="text-brand-dark underline" onClick={onSignOut}>
        Use a different wallet
      </button>
    </p>
  );
}
