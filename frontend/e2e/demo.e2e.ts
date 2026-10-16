// Browser end-to-end test of the full demo, driven through the UI in system Chrome.
// Each persona gets its own browser context with an injected EIP-1193 wallet (standing in for
// MetaMask) backed by the Hardhat test keys, so every on-chain action is really signed and sent.
//
// Needs: chain + fresh `npm run deploy`, all four services, `npm run seed`, and `npm run web`.
//   npx tsx --test frontend/e2e/demo.e2e.ts
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type BaseWallet, HDNodeWallet, JsonRpcProvider, Wallet, getBytes } from "ethers";
import { type Browser, type Page, chromium } from "playwright-core";

const BASE = process.env.E2E_WEB_URL ?? "http://localhost:5173";
const SHOTS = process.env.SCREENSHOT_DIR ?? join(import.meta.dirname, "screenshots");
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

/** Admin: what the sensor records on a leg (set before the leg ends). */
async function setRecording(leg: number, recording: "compliant" | "breach") {
  const page = pages.admin;
  await page.goto(`${BASE}/app?tab=demo`);
  await page.getByLabel(`What the sensor records on leg ${leg}`).first().selectOption(recording);
  await page.waitForTimeout(500);
}

/** A custodian uploads the logger file for one leg from their dashboard's "Sensor logs" card. */
async function uploadLog(page: Page, legTitle: string, file: string, expect: "matches" | "mismatch") {
  await page.goto(`${BASE}/app`);
  const card = page.locator("div.rounded-xl", { hasText: legTitle }).filter({ has: page.getByRole("button", { name: "Upload log" }) });
  await card.getByRole("button", { name: "Upload log" }).waitFor({ timeout: 30_000 }); // sensor reports a few seconds after the handover
  await card.getByLabel("Logger file").selectOption({ label: file });
  await card.getByRole("button", { name: "Upload log" }).click();
  await page.getByText(expect === "matches" ? /your log matches the sensor's record/ : /hash mismatch/).waitFor({ timeout: 30_000 });
}

/** The card for one shipment on a dashboard (its outer ShipmentCard). */
const card = (page: Page, name: RegExp) => page.locator("div.rounded-xl", { has: page.getByRole("link", { name }) }).first();

/** Sender: open the handover form on a shipment card, sign a dispatch check, and hand over. */
async function checkAndHandOver(page: Page, shipment: RegExp, button: RegExp, tempC: string, sensorLog?: string) {
  await page.goto(`${BASE}/app`);
  const c = card(page, shipment);
  await c.getByRole("button", { name: button }).click();
  await c.getByLabel("Probe temperature at dispatch").fill(tempC);
  // A handover that ends a sensor leg asks for that leg's log first.
  if (sensorLog) await c.getByLabel(/^Leg \d sensor log$/).selectOption({ label: sensorLog });
  // The supplier's dispatch also records the seal applied after loading.
  if (await c.getByLabel("Seal number").count()) await c.getByLabel("Seal number").fill(SEAL);
  await c.getByRole("button", { name: /sign check & hand over/i }).click();
  await c.getByText(/^Waiting for .* to accept/).waitFor({ timeout: 30_000 });
}

/** Receiver: inspect a pending handover, sign what they found, and take custody. */
async function inspectAndAccept(page: Page, shipment: RegExp, tempC: string, opts: { withIssues?: boolean; shot?: string } = {}) {
  await page.goto(`${BASE}/app`);
  const c = card(page, shipment);
  await c.getByRole("button", { name: /^Inspect & accept/ }).click();
  await c.getByLabel("Probe temperature on receipt").fill(tempC);
  if (opts.withIssues) await c.getByText("Accept with issues", { exact: true }).click();
  if (opts.shot) await shot(page, opts.shot);
  await c.getByRole("button", { name: "Sign check & accept custody" }).click();
  await page.getByRole("button", { name: "Sign check & accept custody" }).waitFor({ state: "detached", timeout: 30_000 });
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

  // The waiting page notices the approval on its own and moves to the buyer dashboard.
  await visitor.waitForURL("**/app", { timeout: 15_000 });
  await visitor.getByRole("heading", { name: "Your deliveries" }).waitFor();
});

test("supplier creates a container with two batches, logs a reading, and checks it out to the carrier", async () => {
  const page = await signInAs("supplier", account(4));
  await page.getByRole("button", { name: "New container" }).click();
  await page.getByLabel("Origin").fill("Melbourne, AU");

  const batch = (i: number) => page.locator("fieldset").nth(i);
  const fillBatch = async (i: number, product: string, buyer: string, inspector: string, sensor: string, maxC: string) => {
    await batch(i).getByLabel("Product").fill(product);
    await batch(i).getByLabel("Quantity").fill("500");
    await batch(i).getByLabel("Buyer").selectOption({ label: buyer });
    await batch(i).getByLabel("Quality Inspector").selectOption({ label: inspector });
    await batch(i).getByLabel("Batch sensor").selectOption(sensor);
    await batch(i).getByLabel("Max °C").fill(maxC);
  };
  await fillBatch(0, "Chilled salmon fillets", "Tiong Bahru Grocers", "Tiong Bahru Grocers QA", "SENS-B-01", "4");
  await page.getByRole("button", { name: "Add another batch" }).click();
  await fillBatch(1, "Aged cheese", "Marina Bay Dining Group", "Marina Bay Dining QA", "SENS-B-02", "8");
  // A typed container number is checked as you type (ISO 6346 check digit); blank means generate one.
  const number = page.getByLabel("Container number (optional)");
  await number.fill("MSKU9070324");
  await page.getByText(/check digit .* doesn't match/).waitFor();
  assert.equal(await page.getByRole("button", { name: "Create container" }).isDisabled(), true);
  await number.fill("");
  await page.getByRole("button", { name: "Create container" }).click();
  await page.getByRole("link", { name: /^Container CCSU\d{7} from Melbourne, AU$/ }).waitFor({ timeout: 40_000 });

  // Demo setup: the sensor will record a cooling failure on leg 2.
  await setRecording(2, "breach");

  // A spot reading at origin, then the dispatch check.
  await page.goto(`${BASE}/app`);
  const c = card(page, CONTAINER);
  await c.getByRole("button", { name: "Log temperature" }).click();
  await c.getByLabel("Probe °C").fill("2.8");
  await c.getByRole("button", { name: "Save reading" }).click();
  await c.getByText("2.8 °C").waitFor();
  await checkAndHandOver(page, CONTAINER, /Check & hand over to Cargo/, "2.9");
  await shot(page, "05-supplier-dispatched");
});

test("carrier inspects on pickup, reports a reefer failure in transit, and checks out at the destination", async () => {
  const carrier = await signInAs("carrier", account(5));
  await inspectAndAccept(carrier, CONTAINER, "3.0");

  await carrier.goto(`${BASE}/app`);
  const c = card(carrier, CONTAINER);
  await c.getByRole("button", { name: "Report issue" }).click();
  await c.getByLabel("Minutes without refrigeration").fill("25");
  await c.getByLabel("Description").fill("Reefer unit tripped during refuelling stop");
  await c.getByRole("button", { name: "Save issue report" }).click();
  await c.getByText("25 min unrefrigerated").waitFor();
  await c.getByRole("button", { name: /Check & hand over to Destination Freight Handler/ }).click();
  await shot(carrier, "06-carrier-handover-check");
  await c.getByLabel("Probe temperature at dispatch").fill("5.2");
  await c.getByLabel("Leg 1 sensor log").selectOption({ label: "Demo: Compliant log (stays below 4 °C)" });
  await c.getByRole("button", { name: "Upload log, sign check & hand over" }).click();
  await c.getByText(/^Waiting for .* to accept/).waitFor({ timeout: 30_000 });
});

test("the handler finds it warm on receipt: the stage is flagged and QA sees it while the shipment is in transit", async () => {
  const handler = await signInAs("handler", account(6));
  await handler.goto(`${BASE}/app`);
  const c = card(handler, CONTAINER);
  await c.getByRole("button", { name: /^Inspect & accept/ }).click();
  await c.getByLabel("Probe temperature on receipt").fill("7.1");
  await c.getByText("Accept with issues", { exact: true }).click();
  await c.getByText(/This will flag/).first().waitFor(); // live preview before signing
  await shot(handler, "07-handler-receipt-flagged");
  await c.getByRole("button", { name: "Sign check & accept custody" }).click();
  await handler.getByRole("button", { name: "Sign check & accept custody" }).waitFor({ state: "detached", timeout: 30_000 });

  // The carrier uploaded its leg 1 log at handover; it's checked now that the handler has accepted.
  await pages.carrier.goto(`${BASE}/app`);
  await pages.carrier.locator("li", { hasText: "Leg 1 · Cargo" }).getByText("Evidence verified").waitFor({ timeout: 30_000 });

  // QA rules on the flagged stage now, mid-journey.
  const qa = await signInAs("tbInspector", account(10));
  await qa.getByText(/Too warm on receipt/).first().waitFor({ timeout: 30_000 });
  await shot(qa, "08-qa-dashboard-in-transit");
  await qa.getByRole("link", { name: /Claim #/ }).first().click();
  await qa.getByLabel("Resolution note").fill("Carrier's own issue report confirms 25 min without refrigeration; carrier responsible.");
  await qa.getByRole("button", { name: "Sign and submit resolution" }).click();
  await qa.getByText(/^Signed on-chain/).waitFor({ timeout: 30_000 });
});

test("the rest of the journey: cold store, an edited log caught, truck, and the buyers' delivery checks", async () => {
  await checkAndHandOver(pages.handler, CONTAINER, /Check & hand over to Cold Store/, "3.5", "Demo: Breached log (~34 min above 4 °C)");
  const cold = await signInAs("coldStore", account(7));
  await inspectAndAccept(cold, CONTAINER, "3.6");

  await cold.goto(`${BASE}/app`);
  // Splitting ends the cold store's leg: it uploads an edited leg 3 log, then splits.
  await card(cold, CONTAINER).getByLabel("Leg 3 sensor log").selectOption({ label: "Demo: Edited log (breach removed)" });
  await card(cold, CONTAINER).getByRole("button", { name: "Upload log & split into batches" }).click();
  await cold.getByRole("link", { name: /Batch #2 · Chilled salmon fillets/ }).waitFor({ timeout: 30_000 });
  // Once the sensor reports, the edited log is caught.
  await cold.getByText("The last file uploaded for this leg didn't match what the sensor recorded").waitFor({ timeout: 30_000 });
  await shot(cold, "09-cold-store-edited-log-caught");
  await uploadLog(cold, "Leg 3 · Cold Store", "Demo: Compliant log (stays below 4 °C)", "matches");
  await checkAndHandOver(cold, /Batch #2/, /Check & hand over to Reefer Truck/, "3.4");
  await checkAndHandOver(cold, /Batch #3/, /Check & hand over to Reefer Truck/, "3.4");

  const truck = await signInAs("truck", account(8));
  await inspectAndAccept(truck, /Batch #2/, "3.5");
  await inspectAndAccept(truck, /Batch #3/, "3.5");
  await checkAndHandOver(truck, /Batch #2/, /Check & deliver to buyer/, "3.6", "Demo: Compliant log (stays below 4 °C)");
  await checkAndHandOver(truck, /Batch #3/, /Check & deliver to buyer/, "3.6", "Demo: Compliant log (stays below 4 °C)");

  const tbBuyer = await signInAs("tbBuyer", account(9));
  await inspectAndAccept(tbBuyer, /Batch #2/, "3.7", { shot: "10-buyer-delivery-check" });
  const mbBuyer = await signInAs("mbBuyer", account(11));
  await inspectAndAccept(mbBuyer, /Batch #3/, "3.7");

  await pages.admin.goto(`${BASE}/app?tab=demo`);
  await pages.admin.getByRole("button", { name: "Sync now" }).click();
  await pages.admin.waitForTimeout(1500);

  // The batch page tells the whole story: both checks at every handover, and where it went wrong.
  await tbBuyer.goto(`${BASE}/shipments/2`);
  await tbBuyer.getByText(/Problem first detected at/).waitFor({ timeout: 30_000 });
  await shot(tbBuyer, "11-batch-quality-record");
});

test("QA rules on the sensor breach, verifies the log on-chain, and rejects the batch", async () => {
  const qa = pages.tbInspector;
  await qa.goto(`${BASE}/app`);
  await qa.getByRole("link", { name: /Claim #/ }).first().click();
  await qa.locator(".recharts-line").first().waitFor();
  await qa.getByRole("button", { name: "Verify file on-chain" }).click();
  await qa.getByText("Matches the sensor's on-chain commit").waitFor();
  await shot(qa, "12-claim-evidence");
  await qa.getByText("Compensation agreed", { exact: true }).click();
  await qa.getByLabel("Resolution note").fill("Handler agreed a 10% credit; settled between the firms off-platform.");
  await qa.getByRole("button", { name: "Sign and submit resolution" }).click();
  await qa.getByText(/^Signed on-chain/).waitFor({ timeout: 30_000 });

  await qa.goto(`${BASE}/app`);
  await qa.locator("section", { hasText: "Ready for your final decision" }).getByRole("link", { name: /Batch #2/ }).click({ timeout: 30_000 });
  await qa.getByText("Reject", { exact: true }).click();
  await qa.getByLabel("Reason").fill("Core temperature exceeded 4 °C on two stages; not fit for sale.");
  await qa.getByRole("button", { name: "Sign final decision" }).click();
  await qa.getByText("QA rejected this batch: not to be sold").waitFor({ timeout: 30_000 });
  await shot(qa, "13-qa-rejected");
});

test("buyer acknowledges receipt, closing the batch", async () => {
  const page = pages.tbBuyer;
  await page.goto(`${BASE}/app`);
  await page.locator("section", { hasText: "Ready to acknowledge" }).getByRole("link", { name: /Batch #2/ }).click();
  await page.getByRole("button", { name: "Acknowledge receipt" }).click();
  await page.getByText("This batch is closed.").waitFor();
});

test("the printable certificate renders the full record and prints to an A4 PDF", async () => {
  const page = pages.tbBuyer;
  await page.goto(`${BASE}/shipments/2`);
  await page.getByRole("link", { name: "Printable certificate" }).click();
  await page.getByRole("heading", { name: "Cold Chain Quality Certificate" }).waitFor();
  await page.getByText("REJECTED: NOT TO BE SOLD").waitFor();
  await page.getByText("Upheld: custodian responsible").waitFor();
  await page.getByText(/CCSG-\d+-00002/).waitFor();
  await page.getByText(SEAL).waitFor();
  await page.getByText(/reported intact at 3 container handover\(s\)/).waitFor();
  await shot(page, "16-printable-certificate");
  await page.emulateMedia({ media: "print" });
  await page.pdf({ path: join(SHOTS, "certificate-batch-2.pdf"), format: "A4", printBackground: true });
  await page.emulateMedia({ media: "screen" });
});

test("the certificate's QR opens a public verification page with the batch's full transaction history", async () => {
  const print = pages.tbBuyer;
  await print.getByTestId("verify-qr").waitFor();
  const url = await print.getByText(/\/verify\/2\?chain=/).textContent();
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
  for (const step of ["Container registered", "Seal number recorded", "Handover accepted: receiver's quality check", "Sensor committed its log fingerprint", "Final certificate issued", "QA final decision", "Buyer acknowledged receipt"]) {
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
