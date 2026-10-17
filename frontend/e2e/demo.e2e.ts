// Browser end-to-end test of the full demo, driven through the UI in system Chrome.
// Each persona gets its own browser context with an injected EIP-1193 wallet (standing in for
// MetaMask) backed by the Hardhat test keys, so every on-chain action is really signed and sent.
//
// The story: two batches from Merlion Fresh Supplies, salmon (≤ 4 °C, 2 min grace) and cheese
// (≤ 8 °C, 10 min grace). Times are real; the test moves the chain's clock instead of waiting.
//   Cargo's reefer container (its own sensor, export attached) runs at 6.5 °C for 6 minutes:
//     the salmon is flagged, the cheese isn't. The handler also finds the salmon warm on receipt.
//   5 minutes on the dock before the cold store signs the container in: the salmon is flagged,
//     the cheese isn't.
//   The salmon's reefer truck has a demo "breached" sensor: its refrigeration fails on the road.
// QA rules on each flagged stage and rejects the salmon; the buyer closes it; the certificate and
// its public verification page show the whole record.
//
// Needs: chain + fresh `npm run deploy`, all five services, `npm run seed`, and `npm run web`.
//   npx tsx --test frontend/e2e/demo.e2e.ts
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type BaseWallet, HDNodeWallet, JsonRpcProvider, Wallet, getBytes } from "ethers";
import { type Browser, type Page, chromium } from "playwright-core";

const BASE = process.env.E2E_WEB_URL ?? "http://localhost:5173";
const SHOTS = process.env.SCREENSHOT_DIR ?? join(import.meta.dirname, "screenshots");
const REEFER_EXPORT = join(import.meta.dirname, "..", "..", "data", "raw", "reefer-excursion.csv");
const CONTAINER = /Container CCSU\d{7}/; // ISO 6346 number generated on-chain
const SEAL = "SGB4471203";
const MNEMONIC = "test test test test test test test test test test test junk";
const provider = new JsonRpcProvider(process.env.RPC_URL ?? "http://127.0.0.1:8545", undefined, { cacheTimeout: -1 });
const account = (i: number) => HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`);

let browser: Browser;
const pages: Record<string, Page> = {};
const pageErrors: string[] = [];

/** A browser context whose window.ethereum signs with `wallet`. */
async function openAs(name: string, wallet: BaseWallet) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const signer = wallet.connect(provider);
  // One transaction at a time, with a fresh nonce each time (like MetaMask does).
  let queue: Promise<unknown> = Promise.resolve();
  await ctx.exposeBinding("__rpc", async (_source, method: string, params: any[] = []) => {
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return [wallet.address];
      case "eth_chainId":
        return "0x7a69";
      case "wallet_switchEthereumChain":
      case "wallet_addEthereumChain":
        return null;
      case "personal_sign":
        return signer.signMessage(getBytes(params[0]));
      case "eth_sendTransaction": {
        const t = params[0];
        const send = queue.then(async () => (await signer.sendTransaction({ to: t.to, data: t.data, value: t.value ?? 0n, gasLimit: t.gas })).hash);
        queue = send.catch(() => undefined);
        return send;
      }
      default:
        return provider.send(method, params);
    }
  });
  // A string, not a function: tsx would compile a function with helpers that don't exist in the page.
  await ctx.addInitScript(`
    window.ethereum = {
      isMetaMask: true,
      request: ({ method, params }) => window.__rpc(method, params),
      on() {},
      removeListener() {},
    };
  `);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${name}: ${e.message}`));
  page.setDefaultTimeout(20_000);
  pages[name] = page;
  return page;
}

async function signIn(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.getByRole("button", { name: /Connect wallet/ }).click();
}

async function signInAs(name: string, wallet: BaseWallet) {
  const page = await openAs(name, wallet);
  await signIn(page);
  await page.waitForURL("**/app");
  return page;
}

const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });

/** Moves the chain's clock on instead of waiting. Test harness only. */
async function travel(seconds: number) {
  const latest = (await provider.getBlock("latest"))!.timestamp;
  await provider.send("evm_setNextBlockTimestamp", [latest + seconds]);
  await provider.send("evm_mine", []);
}

/** The card for one shipment on a dashboard (its outer ShipmentCard). */
const card = (page: Page, name: RegExp) => page.locator("div.rounded-xl", { has: page.getByRole("link", { name }) }).first();

/** Sender: open the handover form on a shipment card, sign the check, and hand over. */
async function checkAndHandOver(page: Page, shipment: RegExp, button: RegExp, tempC: string) {
  await page.goto(`${BASE}/app`);
  const c = card(page, shipment);
  await c.getByRole("button", { name: button }).click();
  await c.getByLabel("Probe temperature at sign-off").fill(tempC);
  // Cargo seals the container in the same step.
  if (await c.getByLabel("Seal number").count()) await c.getByLabel("Seal number").fill(SEAL);
  await c.getByRole("button", { name: /sign check & hand over/i }).click();
  await c.getByText(/^Waiting for .* to sign it in/).waitFor({ timeout: 30_000 });
}

/** Receiver: inspect a pending handover, sign what they found, and take custody. */
async function inspectAndAccept(page: Page, shipment: RegExp, tempC: string, opts: { withIssues?: boolean; shot?: string } = {}) {
  await page.goto(`${BASE}/app`);
  const c = card(page, shipment);
  await c.getByRole("button", { name: /^Inspect & (accept|receive)/ }).click();
  await c.getByLabel("Probe temperature on receipt").fill(tempC);
  if (opts.withIssues) await c.getByText("Accept with issues", { exact: true }).click();
  if (opts.shot) await shot(page, opts.shot);
  const submit = c.getByRole("button", { name: /^Sign check & (accept custody|receive into container)$/ });
  await submit.click();
  await submit.waitFor({ state: "detached", timeout: 30_000 });
}

/** A holder registers its sensor from the shipment's card. */
async function registerSensor(page: Page, shipment: RegExp, prompt: string, option: string) {
  await page.goto(`${BASE}/app`);
  const c = card(page, shipment);
  await c.getByLabel(prompt).selectOption({ label: option });
  await c.getByRole("button", { name: "Register sensor" }).click();
  await c.getByRole("button", { name: "Register sensor" }).waitFor({ state: "detached", timeout: 30_000 });
}

before(async () => {
  mkdirSync(SHOTS, { recursive: true });
  browser = await chromium.launch({ channel: "chrome", headless: true });
});

after(async () => {
  await browser?.close();
});

test("landing page and onboarding: a new wallet requests access and the admin approves", async () => {
  const visitor = await openAs("newcomer", Wallet.createRandom());
  await visitor.goto(BASE);
  await shot(visitor, "01-landing");
  await signIn(visitor);
  await visitor.getByRole("heading", { name: "Request access" }).waitFor();
  await visitor.getByLabel("Organisation name").fill("Orchard Fresh Mart");
  await visitor.getByLabel("Contact email").fill("orders@orchardfresh.example");
  await visitor.getByLabel("Your role in the cold chain").selectOption("BUYER");
  await shot(visitor, "02-request-access");
  await visitor.getByRole("button", { name: "Send request" }).click();
  await visitor.getByRole("heading", { name: "Waiting for approval" }).waitFor();

  const admin = await signInAs("admin", new Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"));
  await admin.goto(`${BASE}/app?tab=requests`);
  await admin.getByText("Orchard Fresh Mart").waitFor();
  await shot(admin, "03-admin-requests");
  await admin.getByRole("button", { name: "Approve" }).click();
  await admin.getByText("No pending requests.").waitFor();
  // The admin runs the platform only: no sensor or demo controls.
  assert.equal(await admin.getByRole("button", { name: /Sensors|Demo control/ }).count(), 0);

  // The waiting page notices the approval on its own and moves to the buyer dashboard.
  await visitor.waitForURL("**/app", { timeout: 15_000 });
  await visitor.getByRole("heading", { name: "Your deliveries" }).waitFor();
});

test("the supplier creates two batches, covers them with its cold-room sensor, and signs them off to Cargo", async () => {
  const page = await signInAs("supplier", account(4));
  await page.getByRole("button", { name: "New batches" }).click();

  const batch = (i: number) => page.locator("fieldset").nth(i);
  const fillBatch = async (i: number, product: string, buyer: string, inspector: string, maxC: string) => {
    await batch(i).getByLabel("Product").fill(product);
    await batch(i).getByLabel("Quantity").fill("500");
    await batch(i).getByLabel("Buyer").selectOption({ label: buyer });
    await batch(i).getByLabel("Quality Inspector").selectOption({ label: inspector });
    await batch(i).getByLabel("Max °C").fill(maxC);
  };
  await fillBatch(0, "Chilled salmon fillets", "Tiong Bahru Grocers", "Tiong Bahru Grocers QA", "4");
  await batch(0).getByLabel("Grace (min)").fill("2");
  await page.getByRole("button", { name: "Add another batch" }).click();
  await fillBatch(1, "Aged cheese", "Marina Bay Dining Group", "Marina Bay Dining QA", "8");
  await batch(1).getByLabel("Grace (min)").fill("10");
  assert.equal(await page.getByRole("button", { name: "Create batches" }).isDisabled(), true, "a sensor is required");
  await page.getByLabel("Cold-room sensor").selectOption({ label: "Demo simulation: compliant sensor registration" });
  await shot(page, "04-supplier-new-batches");
  await page.getByRole("button", { name: "Create batches" }).click();
  await page.getByRole("link", { name: "Batch #1 · Chilled salmon fillets" }).waitFor({ timeout: 40_000 });

  // A spot reading in the cold room, then each batch is signed off.
  const c = card(page, /Batch #1/);
  await c.getByRole("button", { name: "Log temperature" }).click();
  await c.getByLabel("Probe °C").fill("2.8");
  await c.getByRole("button", { name: "Save reading" }).click();
  await c.getByText("2.8 °C").waitFor();
  await checkAndHandOver(page, /Batch #1/, /Check & hand over to Cargo/, "2.9");
  await checkAndHandOver(page, /Batch #2/, /Check & hand over to Cargo/, "3.0");
  await shot(page, "05-supplier-signed-off");
});

test("Cargo opens a container with its own sensor, receives both batches into it, and ships it by sea", async () => {
  const carrier = await signInAs("carrier", account(5));
  await carrier.getByRole("button", { name: "Open a container" }).click();
  // A typed container number is checked as you type (ISO 6346 check digit); blank means generate one.
  const number = carrier.getByLabel("Container number (optional)");
  await number.fill("MSKU9070324");
  await carrier.getByText(/check digit .* doesn't match/).waitFor();
  await number.fill("");
  await carrier.getByLabel("Vessel / voyage").fill("MSC AURORA 041E");
  await carrier.getByLabel("Origin").fill("Melbourne, AU");
  // Cargo's own reefer sensor: its controller export stands in for the live feed.
  await carrier.getByLabel("Container sensor").selectOption({ label: "Register your sensor for this supply" });
  await carrier.getByLabel("Sensor id").fill("RCU-88213");
  await carrier.getByLabel("Sensor export").setInputFiles(REEFER_EXPORT);
  await shot(carrier, "06-cargo-open-container");
  await carrier.getByRole("button", { name: "Open container" }).click();
  await carrier.getByRole("link", { name: /^Container CCSU\d{7} · Melbourne, AU → Singapore$/ }).waitFor({ timeout: 40_000 });

  await inspectAndAccept(carrier, /Batch #1/, "3.0");
  await inspectAndAccept(carrier, /Batch #2/, "3.1");

  await carrier.goto(`${BASE}/app`);
  const c = card(carrier, CONTAINER);
  await c.getByRole("link", { name: /Batch #2 · Aged cheese/ }).waitFor();
  await c.getByRole("button", { name: "Report issue" }).click();
  await c.getByLabel("Minutes without refrigeration").fill("20");
  await c.getByLabel("Description").fill("Reefer defrost fault mid-voyage; reset by the crew");
  await c.getByRole("button", { name: "Save issue report" }).click();
  await c.getByText("20 min unrefrigerated").waitFor();

  await travel(10 * 60); // 10 minutes at sea
  await checkAndHandOver(carrier, CONTAINER, /Check & hand over to Destination Freight Handler/, "5.2");
});

test("the handler signs the container in and finds the salmon warm; QA sees it while the shipment is in transit", async () => {
  const handler = await signInAs("handler", account(6));
  await handler.goto(`${BASE}/app`);
  const c = card(handler, CONTAINER);
  await c.getByRole("button", { name: /^Inspect & accept/ }).click();
  await c.getByLabel("Probe temperature on receipt").fill("6.8");
  await c.getByText(/This will flag/).first().waitFor(); // live preview: 6.8 °C is over the salmon's 4 °C, under the cheese's 8 °C
  await shot(handler, "07-handler-receipt-flagged");
  await c.getByRole("button", { name: "Sign check & accept custody" }).click();
  await handler.getByRole("button", { name: "Sign check & accept custody" }).waitFor({ state: "detached", timeout: 30_000 });

  // QA rules on the flagged stage now, mid-journey: Cargo's own sensor shows the excursion too.
  const qa = await signInAs("tbInspector", account(10));
  await qa.getByText(/Too warm on receipt/).first().waitFor({ timeout: 30_000 });
  await shot(qa, "08-qa-dashboard-in-transit");
  await qa.getByRole("link", { name: /Claim #/ }).first().click();
  await qa.getByText(/Sensor above limit too long/).first().waitFor({ timeout: 30_000 });
  await qa.getByLabel("Resolution note").fill("Cargo's own reefer export shows 6 minutes at 6.5 °C; Cargo responsible.");
  await qa.getByRole("button", { name: "Sign and submit resolution" }).click();
  await qa.getByText(/^Signed on-chain/).waitFor({ timeout: 30_000 });
});

test("5 minutes on the dock, the cold store unloads, two reefer trucks deliver, and the buyers sign in", async () => {
  await checkAndHandOver(pages.handler, CONTAINER, /Check & hand over to Cold Store/, "3.5");
  await travel(5 * 60); // 5 minutes on the dock
  const cold = await signInAs("coldStore", account(7));
  await inspectAndAccept(cold, CONTAINER, "3.6");

  await registerSensor(cold, CONTAINER, "Register your cold-room sensor", "Demo simulation: compliant sensor registration");
  await card(cold, CONTAINER).getByRole("button", { name: "Unload container" }).click();
  await card(cold, /Batch #1/).getByRole("button", { name: /Check & hand over to Reefer Truck/ }).waitFor({ timeout: 30_000 });
  await shot(cold, "09-cold-store-unloaded");
  await checkAndHandOver(cold, /Batch #1/, /Check & hand over to Reefer Truck/, "3.4");
  await checkAndHandOver(cold, /Batch #2/, /Check & hand over to Reefer Truck/, "3.4");

  const truck = await signInAs("truck", account(8));
  await inspectAndAccept(truck, /Batch #1/, "3.5");
  await inspectAndAccept(truck, /Batch #2/, "3.5");
  // The salmon's truck: a demo sensor whose refrigeration fails on the road.
  await registerSensor(truck, /Batch #1/, "Register your truck's sensor", "Demo simulation: breached sensor registration");
  await registerSensor(truck, /Batch #2/, "Register your truck's sensor", "Demo simulation: compliant sensor registration");
  await travel(10 * 60); // 10 minutes on the road
  await checkAndHandOver(truck, /Batch #1/, /Check & deliver to buyer/, "8.9");
  await checkAndHandOver(truck, /Batch #2/, /Check & deliver to buyer/, "3.6");

  const tbBuyer = await signInAs("tbBuyer", account(9));
  await inspectAndAccept(tbBuyer, /Batch #1/, "8.7", { withIssues: true, shot: "10-buyer-delivery-check" });
  const mbBuyer = await signInAs("mbBuyer", account(11));
  await inspectAndAccept(mbBuyer, /Batch #2/, "3.7");

  // The batch page tells the whole story: every holder's sensor, the gaps between them, and where it went wrong.
  await tbBuyer.goto(`${BASE}/shipments/1`);
  await tbBuyer.getByText(/Problem first detected while with/).waitFor({ timeout: 30_000 });
  await tbBuyer.getByText(/Handover to the next holder: \d+ min on the dock/).first().waitFor({ timeout: 30_000 });
  await tbBuyer.locator(".recharts-reference-area").first().waitFor({ timeout: 30_000 });
  await shot(tbBuyer, "11-batch-quality-record");
});

test("QA rules on each flagged stage, verifies the readings on-chain, and rejects the salmon", async () => {
  const qa = pages.tbInspector;
  const toRule = () => qa.locator("section", { hasText: "Flagged stages to rule on" }).getByRole("link", { name: /Claim #/ });
  // Two stages still await a ruling: the handler's dock time (stage 2) and the truck (stage 4).
  for (const i of [0, 1]) {
    await qa.goto(`${BASE}/app`);
    await toRule().first().click({ timeout: 30_000 });
    if (i === 0) {
      await qa.getByRole("button", { name: "Verify readings on-chain" }).first().click();
      await qa.getByText(/The stored readings match the sensor's on-chain commit/).waitFor();
      await shot(qa, "12-claim-evidence");
      await qa.getByText("Compensation agreed", { exact: true }).click();
      await qa.getByLabel("Resolution note").fill("Handler agreed a 10% credit for the time on the dock; settled off-platform.");
    } else {
      await qa.getByLabel("Resolution note").fill("Truck's own sensor shows its refrigeration failed; trucking firm responsible.");
    }
    await qa.getByRole("button", { name: "Sign and submit resolution" }).click();
    await qa.getByText(/^Signed on-chain/).waitFor({ timeout: 30_000 });
  }
  await qa.goto(`${BASE}/app`);

  await qa.locator("section", { hasText: "Ready for your final decision" }).getByRole("link", { name: /Batch #1/ }).click({ timeout: 30_000 });
  await qa.getByText("Reject", { exact: true }).click();
  await qa.getByLabel("Reason").fill("Above 4 °C at sea, 5 minutes on the dock, and the truck's refrigeration failed; not fit for sale.");
  await qa.getByRole("button", { name: "Sign final decision" }).click();
  await qa.getByText("QA rejected this batch: not to be sold").waitFor({ timeout: 30_000 });
  await shot(qa, "13-qa-rejected");
});

test("the same journey within the cheese's limits: a clean certificate", async () => {
  const page = pages.mbBuyer;
  await page.goto(`${BASE}/shipments/2`);
  await page.getByText("All 5 handover checks passed").waitFor({ timeout: 30_000 });
});

test("buyer acknowledges receipt, closing the batch", async () => {
  const page = pages.tbBuyer;
  await page.goto(`${BASE}/app`);
  await page.locator("section", { hasText: "Ready to acknowledge" }).getByRole("link", { name: /Batch #1/ }).click();
  await page.getByRole("button", { name: "Acknowledge receipt" }).click();
  await page.getByText("This batch is closed.").waitFor();
});

test("the printable certificate renders the full record and prints to an A4 PDF", async () => {
  const page = pages.tbBuyer;
  await page.goto(`${BASE}/shipments/1`);
  await page.getByRole("link", { name: "Printable certificate" }).click();
  await page.getByRole("heading", { name: "Cold Chain Quality Certificate" }).waitFor();
  await page.getByText("REJECTED: NOT TO BE SOLD").waitFor();
  await page.getByText(/Upheld: custodian responsible/).first().waitFor();
  await page.getByText(/CCSG-\d+-00001/).waitFor();
  await page.getByText(SEAL).waitFor();
  await page.getByText(/reported intact at 2 container handover\(s\)/).waitFor();
  await page.getByText(/RCU-88213/).waitFor();
  await shot(page, "16-printable-certificate");
  await page.emulateMedia({ media: "print" });
  await page.pdf({ path: join(SHOTS, "certificate-batch-1.pdf"), format: "A4", printBackground: true });
  await page.emulateMedia({ media: "screen" });
});

test("the certificate's QR opens a public verification page with the batch's full transaction history", async () => {
  const print = pages.tbBuyer;
  await print.getByTestId("verify-qr").waitFor();
  const url = await print.getByText(/\/verify\/1\?chain=/).textContent();
  assert.ok(url);
  await print.getByText(/Issued in tx/).waitFor();

  // A stranger with no wallet and no session.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const visitor = await ctx.newPage();
  visitor.on("pageerror", (e) => pageErrors.push(`visitor: ${e.message}`));
  visitor.setDefaultTimeout(20_000);
  await visitor.goto(url!.trim());
  const verdict = visitor.getByTestId("verify-verdict");
  await verdict.getByText("certificate found on-chain").waitFor();
  await verdict.getByText("rejected, not to be sold").waitFor();
  await visitor.getByText(/^CCSU\d{7}$/).waitFor();
  await visitor.getByText(SEAL, { exact: true }).waitFor();
  const history = visitor.getByTestId("tx-history");
  for (const step of [
    "Batch created by the supplier",
    "Sensor registered by its owner",
    "Received into the container: receiver's check (entry)",
    "Container sealed",
    "Signed off: sender's check (exit)",
    "Container unloaded at the cold store",
    "Sensor committed its readings",
    "Final certificate issued",
    "QA final decision",
    "Buyer acknowledged receipt",
  ]) {
    await history.getByText(step, { exact: true }).first().waitFor();
  }
  // Organisation names come from the public directory, never contact details.
  await visitor.getByText(/\(Buyer\)/).first().waitFor();
  assert.equal(await visitor.getByText("@").count(), 0);
  await history.getByRole("button", { name: /Buyer acknowledged receipt/ }).click();
  await history.getByText(/success · gas/).waitFor();
  await shot(visitor, "17-public-verification");

  // A certificate printed from another registry is called out.
  await visitor.goto(url!.trim().replace(/registry=0x[0-9a-fA-F]+/, "registry=0x000000000000000000000000000000000000dEaD"));
  await visitor.getByText(/may not be the one on the certificate/).waitFor();
  await ctx.close();
});

test("admin overview and audit log render the live record", async () => {
  const admin = pages.admin;
  await admin.goto(`${BASE}/app?tab=overview`);
  await admin.getByText("Flagged stages by custody stage").waitFor();
  await admin.locator(".recharts-bar-rectangle").first().waitFor();
  await shot(admin, "14-admin-overview");
  await admin.goto(`${BASE}/app?tab=audit`);
  await admin.getByText("DispositionSubmitted").waitFor();
  await shot(admin, "15-audit-log");
});

test("no uncaught errors in any page", () => {
  assert.deepEqual(pageErrors, []);
});
