// Landing-page hero: a container travels the six custody stops. Each handover seals that leg's
// sensor evidence, the container splits into batches at the cold store, and the run ends in a
// clean certificate. Respects prefers-reduced-motion by showing the finished state.
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { BadgeCheck, Container, Factory, Lock, Package, Plane, PlaneLanding, Refrigerator, Store, Truck } from "lucide-react";
import { useEffect, useState } from "react";

const STOPS = [
  { label: "Supplier", Icon: Factory },
  { label: "Air carrier", Icon: Plane },
  { label: "Changi handler", Icon: PlaneLanding },
  { label: "Cold store", Icon: Refrigerator },
  { label: "Delivery truck", Icon: Truck },
  { label: "Buyer", Icon: Store },
];
const READINGS = ["2.9", "3.1", "2.7", "2.4", "3.0", "2.8"];
const LAST = STOPS.length - 1;
const CERTIFICATE = STOPS.length; // the step after the last stop
const SPLIT_AT = 3; // cold store

const pct = (i: number) => `${(i / LAST) * 100}%`;

export function RouteAnimation() {
  const reduce = useReducedMotion();
  const [step, setStep] = useState(reduce ? CERTIFICATE : 0);

  useEffect(() => {
    if (reduce) {
      setStep(CERTIFICATE);
      return;
    }
    // Hold longer on the certificate before starting over.
    const timer = setTimeout(() => setStep((s) => (s >= CERTIFICATE ? 0 : s + 1)), step === CERTIFICATE ? 3200 : 1100);
    return () => clearTimeout(timer);
  }, [step, reduce]);

  const at = Math.min(step, LAST);
  const split = step >= SPLIT_AT;

  return (
    <div
      className="relative rounded-3xl border border-line bg-white px-4 pb-8 pt-20 shadow-sm sm:px-12"
      role="img"
      aria-label="A container moves from supplier to air carrier, Changi handler, cold store, delivery truck and buyer. Each handover seals that leg's temperature evidence, and the journey ends with a clean quality certificate."
    >
      <div className="relative mx-3 sm:mx-8">
        {/* The travelling shipment, with its live temperature reading */}
        <motion.div
          className="absolute -top-16 -translate-x-1/2"
          initial={false}
          animate={{ left: pct(at) }}
          transition={{ type: "spring", stiffness: 70, damping: 16 }}
        >
          <div className="flex flex-col items-center gap-1">
            <span className="whitespace-nowrap rounded-full bg-ice px-2 py-0.5 text-[11px] font-semibold tabular-nums text-sky-800">
              {READINGS[at]} °C
            </span>
            <AnimatePresence mode="wait" initial={false}>
              {split ? (
                <motion.div
                  key="batches"
                  className="flex -space-x-2 sm:gap-0.5 sm:space-x-0"
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0 }}
                >
                  {[0, 1, 2].map((i) => (
                    <span key={i} className="grid size-5 place-items-center rounded-md bg-brand text-white shadow ring-2 ring-white sm:size-6 sm:ring-0">
                      <Package className="size-3 sm:size-3.5" aria-hidden />
                    </span>
                  ))}
                </motion.div>
              ) : (
                <motion.div
                  key="container"
                  className="grid h-7 w-11 place-items-center rounded-md bg-brand text-white shadow"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, scale: 0.6 }}
                >
                  <Container className="size-4" aria-hidden />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>

        {/* Track with progress fill */}
        <div className="absolute inset-x-0 top-4 h-1 rounded-full bg-line sm:top-5" />
        <motion.div
          className="absolute left-0 top-4 h-1 rounded-full bg-brand sm:top-5"
          initial={false}
          animate={{ width: pct(at) }}
          transition={{ type: "spring", stiffness: 70, damping: 16 }}
        />

        {/* Stops */}
        <ol className="relative flex justify-between">
          {STOPS.map(({ label, Icon }, i) => {
            const reached = i <= at;
            const sealed = i < at || step === CERTIFICATE;
            return (
              <li key={label} className="flex w-0 flex-col items-center">
                <span
                  className={`relative grid size-9 shrink-0 place-items-center rounded-full border-2 transition-colors duration-500 sm:size-11 ${
                    reached ? "border-brand bg-brand-soft text-brand-dark" : "border-line bg-white text-muted"
                  }`}
                >
                  <Icon className="size-4 sm:size-5" aria-hidden />
                </span>
                {/* Narrow on phones so six labels fit; long ones wrap onto two lines. */}
                <span className="mt-2 h-6 w-14 text-center text-[10px] font-medium leading-tight sm:h-auto sm:w-24 sm:text-xs">{label}</span>
                <span className="mt-1 h-4">
                  <AnimatePresence>
                    {/* Legs 1-4 carry sensor evidence: the supplier and buyer ends do not. */}
                    {sealed && i > 0 && i < LAST && (
                      <motion.span
                        className="inline-flex items-center gap-0.5 rounded-full bg-pass-soft px-1.5 py-px text-[10px] font-semibold text-pass"
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                      >
                        <Lock className="size-2.5" aria-label="sealed" />
                        <span className="hidden sm:inline">sealed</span>
                      </motion.span>
                    )}
                  </AnimatePresence>
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      {/* The payoff: a certificate */}
      <div className="mt-6 flex h-16 justify-center">
        <AnimatePresence>
          {step === CERTIFICATE && (
            <motion.div
              className="flex items-center gap-3 rounded-2xl border border-pass/20 bg-pass-soft px-5 py-3"
              initial={{ opacity: 0, scale: 0.85, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ type: "spring", stiffness: 220, damping: 18 }}
            >
              <BadgeCheck className="size-7 text-pass" aria-hidden />
              <div className="leading-tight">
                <div className="text-sm font-semibold text-pass">Quality certificate: Clean</div>
                <div className="text-xs text-pass/80">4 of 4 legs within 4 °C · evidence hash-verified</div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
