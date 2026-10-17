// Public landing page: the problem, how ColdChainSG answers it, and a way in.
import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight, BadgeCheck, FileWarning, Fingerprint, Handshake, Info, Repeat2, ShieldCheck, Wallet, X } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { useAuth } from "../auth";
import { Logo } from "../components/Layout";
import { RouteAnimation } from "../components/RouteAnimation";

const STEPS = [
  {
    Icon: Wallet,
    title: "Join with your wallet",
    body: "Suppliers, carriers, handlers, cold stores, trucks, buyers and quality inspectors sign in with MetaMask. The admin approves each firm and its role on-chain.",
  },
  {
    Icon: Repeat2,
    title: "Check at every handover",
    body: "The sender records the temperature, time out of refrigeration and condition before handing over; the receiver inspects on arrival. Both sign, so a problem is pinned to the stage where it happened.",
  },
  {
    Icon: Fingerprint,
    title: "Cross-check with the sensor",
    body: "Each leg's logger file is fingerprinted (SHA-256) by the sensor itself. A log edited before upload no longer matches, and it's caught automatically.",
  },
  {
    Icon: BadgeCheck,
    title: "QA rules and decides",
    body: "Flagged stages go straight to the buyer's QA team, even mid-journey. They rule on who's responsible, then release the batch for sale or reject it. The buyer closes it.",
  },
];

const BEFORE = [
  "Logger exports, emails and PDFs spread across five or more firms",
  "Each party holds a different version of what happened",
  "Temperature files can be edited before they're shared",
  "Weeks of back-and-forth to work out who held it when",
];
const AFTER = [
  "One shared record from supplier to buyer",
  "A signed quality check by both sides at every handover",
  "Problems flagged the moment they're found, pinned to the stage and its custodian",
  "QA decides with all the evidence in one place: checks, logs, sensor data",
];

// Illustrative demo figures: labelled as such on the page.
const IMPACT = [
  { value: "Minutes", label: "to pull together dispute evidence", hint: "instead of chasing files across firms" },
  { value: "6 → 1", label: "custody stops, one record", hint: "supplier to buyer, every handover signed" },
  { value: "100%", label: "of legs with a hash-checked sensor file", hint: "tampered files are flagged, not trusted" },
  { value: "$0", label: "moved by the platform", hint: "evidence only: firms settle off-platform" },
];

function Reveal({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.5, delay }}
    >
      {children}
    </motion.div>
  );
}

function ConnectButton({ large }: { large?: boolean }) {
  const { session } = useAuth();
  const signedIn = !!session?.role;
  return (
    <Link
      to={signedIn ? "/app" : "/login"}
      className={`inline-flex items-center gap-2 rounded-xl bg-brand font-medium text-white shadow-sm transition-colors hover:bg-brand-dark ${
        large ? "px-6 py-3.5 text-base" : "px-4 py-2 text-sm"
      }`}
    >
      {signedIn ? "Open dashboard" : (
        <>
          <Wallet className="size-4" aria-hidden /> Connect wallet
        </>
      )}
      <ArrowRight className="size-4" aria-hidden />
    </Link>
  );
}

export function Landing() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-sky-50 via-canvas to-canvas">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5">
        <Logo />
        <ConnectButton />
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-4 pb-16 pt-8 sm:pt-14">
        <div className="mx-auto max-w-3xl text-center">
          <p className="inline-flex items-center gap-2 rounded-full border border-brand/20 bg-white px-3 py-1 text-xs font-medium text-brand-dark">
            <ShieldCheck className="size-3.5" aria-hidden /> Tamper-evident evidence for Singapore's cold chain
          </p>
          <h1 className="mt-6 text-4xl font-semibold tracking-tight sm:text-5xl">
            When chilled food arrives warm, know exactly where it went wrong.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-muted">
            ColdChainSG seals temperature evidence at every handover, from the origin port or airport to the buyer's door, so the firms
            involved can settle disputes from one shared, verifiable record.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <ConnectButton large />
            <a href="#how-it-works" className="rounded-xl border border-line bg-white px-6 py-3.5 font-medium hover:bg-canvas">
              How it works
            </a>
          </div>
        </div>
        <div className="mt-14">
          <RouteAnimation />
        </div>
      </section>

      {/* Problem */}
      <section className="border-y border-line bg-white">
        <div className="mx-auto max-w-6xl px-4 py-16">
          <Reveal>
            <div className="max-w-3xl">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-brand-dark">The problem</h2>
              <p className="mt-3 text-2xl font-medium leading-snug tracking-tight">
                A chilled shipment changes hands five times between the supplier and the buyer's door. When it arrives
                warm, the temperature evidence is scattered across every firm's loggers, spreadsheets and emails. Any
                of it could have been edited, and nobody can say for sure who held the batch when it warmed up. So
                disputes drag on for weeks.
              </p>
            </div>
          </Reveal>
          <div className="mt-10 grid gap-4 md:grid-cols-2">
            <Reveal delay={0.05}>
              <Compare title="Today" tone="before" items={BEFORE} />
            </Reveal>
            <Reveal delay={0.15}>
              <Compare title="With ColdChainSG" tone="after" items={AFTER} />
            </Reveal>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="mx-auto max-w-6xl scroll-mt-8 px-4 py-20">
        <Reveal>
          <h2 className="text-3xl font-semibold tracking-tight">How it works</h2>
          <p className="mt-2 text-muted">Four steps, from onboarding to a closed batch.</p>
        </Reveal>
        <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map(({ Icon, title, body }, i) => (
            <li key={title}>
              <Reveal delay={i * 0.08}>
                <div className="h-full rounded-2xl border border-line bg-white p-6">
                  <div className="flex items-center gap-3">
                    <span className="grid size-10 place-items-center rounded-xl bg-brand-soft text-brand-dark">
                      <Icon className="size-5" aria-hidden />
                    </span>
                    <span className="text-sm font-semibold text-muted">Step {i + 1}</span>
                  </div>
                  <h3 className="mt-4 font-semibold">{title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{body}</p>
                </div>
              </Reveal>
            </li>
          ))}
        </ol>
        <Reveal>
          <p className="mt-6 flex items-start gap-2 text-sm text-muted">
            <Handshake className="mt-0.5 size-4 shrink-0" aria-hidden />
            ColdChainSG is a neutral evidence layer. It never holds or moves money: it shows where things went wrong and
            who held the batch, and the firms settle between themselves.
          </p>
        </Reveal>
      </section>

      {/* Impact */}
      <section className="bg-ink text-white">
        <div className="mx-auto max-w-6xl px-4 py-20">
          <Reveal>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <h2 className="text-3xl font-semibold tracking-tight">Why it matters</h2>
              <p className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs text-white/80">
                <Info className="size-3.5" aria-hidden /> Illustrative figures for this course demo, not measured results
              </p>
            </div>
          </Reveal>
          <dl className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {IMPACT.map((s, i) => (
              <Reveal key={s.label} delay={i * 0.08}>
                <div className="h-full rounded-2xl border border-white/10 bg-white/5 p-6">
                  <dd className="text-4xl font-semibold tracking-tight text-teal-300">{s.value}</dd>
                  <dt className="mt-2 font-medium">{s.label}</dt>
                  <dd className="mt-1 text-sm text-white/60">{s.hint}</dd>
                </div>
              </Reveal>
            ))}
          </dl>
        </div>
      </section>

      {/* Final call to action */}
      <section className="mx-auto max-w-6xl px-4 py-20 text-center">
        <Reveal>
          <h2 className="text-3xl font-semibold tracking-tight">See a shipment's whole story</h2>
          <p className="mx-auto mt-3 max-w-xl text-muted">
            Connect your wallet to track a container, hand over custody, or review a flagged batch. New firms can
            request access in under a minute.
          </p>
          <div className="mt-8">
            <ConnectButton large />
          </div>
        </Reveal>
      </section>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-xs text-muted">
          <span>ColdChainSG · DBA5102 Blockchain course prototype · simulated sensor data</span>
          <span className="inline-flex items-center gap-1">
            <Handshake className="size-3.5" aria-hidden /> No payments, escrow or tokens: evidence only
          </span>
        </div>
      </footer>
    </div>
  );
}

function Compare({ title, tone, items }: { title: string; tone: "before" | "after"; items: string[] }) {
  const before = tone === "before";
  return (
    <div className={`h-full rounded-2xl border p-6 ${before ? "border-line bg-canvas" : "border-brand/20 bg-brand-soft/60"}`}>
      <h3 className={`flex items-center gap-2 font-semibold ${before ? "text-muted" : "text-brand-dark"}`}>
        {before ? <FileWarning className="size-4" aria-hidden /> : <ShieldCheck className="size-4" aria-hidden />}
        {title}
      </h3>
      <ul className="mt-4 space-y-3 text-sm">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-2">
            {before ? (
              <X className="mt-0.5 size-4 shrink-0 text-fail" aria-hidden />
            ) : (
              <BadgeCheck className="mt-0.5 size-4 shrink-0 text-pass" aria-hidden />
            )}
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
