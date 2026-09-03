// Multi-agent drill: several personas work one incident together, through the
// real registered WebMCP tools in real browser pages.
//
// The default path is the one a judge takes: open the app with no secret, click
// "Start my own incident", and let the first claimer take the commander seat.
// `--commander <token>` switches to the curated room instead.
//
//   node tools/agent-drill.mjs                       # self-serve, production
//   node tools/agent-drill.mjs --app http://127.0.0.1:5173
//   node tools/agent-drill.mjs --personas 5 --headed
//   node tools/agent-drill.mjs --room p1-storefront --commander "$TOKEN"
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Mirrors TOOL_NAMES.length in shared/tools.ts. This file runs under a bare
// `node`, which cannot import the TypeScript contract; a unit test asserts the
// two never drift apart.
const EXPECTED_TOOLS = 13;

const repo = (relative) => fileURLToPath(new URL(`../${relative}`, import.meta.url));

const flag = (name) => process.argv.includes(name);
const arg = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : process.argv[at + 1];
};

const appOrigin = arg("--app", "https://multicom-web.pages.dev");
const targetOrigin = arg(
  "--target",
  "https://multicom-storefront-api.multicom-target.workers.dev",
);
const requestedRoom = arg("--room", "");
const personaCount = Math.max(2, Math.min(6, Number.parseInt(arg("--personas", "3"), 10) || 3));
const headed = flag("--headed");

// `--room` selects the curated room and therefore the shared secret. Without
// it the drill takes the judge's path, and a stray `.commander-token` on disk
// must not quietly switch modes — that turned a green drill into a
// commander_forbidden failure against a local Worker with a different secret.
const selfServe = !requestedRoom;
const looksLikeToken = (value) => /^[0-9a-f]{64}$/.test(value ?? "");
const tokenFromFile = selfServe
  ? ""
  : await readFile(repo(".commander-token"), "utf8")
      .then((raw) => raw.trim())
      .catch(() => "");
const suppliedToken = selfServe
  ? ""
  : arg("--commander", "") || tokenFromFile || process.env.COMMANDER_TOKEN || "";
const commanderToken = looksLikeToken(suppliedToken) ? suppliedToken : "";

const PERSONAS = [
  { name: "Priya", role: "commander", blurb: "senior SRE, on-call lead" },
  { name: "Arjun", role: "responder", blurb: "backend engineer, DB specialist" },
  { name: "Mei", role: "responder", blurb: "platform engineer, deploys and flags" },
  { name: "Tomas", role: "responder", blurb: "checkout service owner" },
  { name: "Aisha", role: "responder", blurb: "observability" },
  { name: "Kwame", role: "responder", blurb: "incident scribe" },
];

let failures = 0;
const log = (persona, marker, message) => console.log(`  ${marker} [${persona}] ${message}`);
const sep = () => console.log("-".repeat(72));

// Strict, because the drill exists to catch a shape regression. The first
// version papered over the result envelope with `??` chains and would have
// reported success against a completely different payload.
const check = (label, condition, detail = "") => {
  const passed = condition === true;
  if (!passed) failures += 1;
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  return passed;
};

const browser = await chromium.launch({ headless: !headed });

async function newAgentPage(search) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const tools = {};
    window.__tools = tools;
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: { registerTool: (tool) => { tools[tool.name] = tool; } },
    });
  });
  await page.goto(`${appOrigin}/${search ? `?${search}` : ""}`);
  return page;
}

async function waitForTools(page) {
  await page.waitForFunction(
    (expected) => Object.keys(window.__tools ?? {}).length === expected,
    EXPECTED_TOOLS,
    { timeout: 30_000 },
  );
}

const call = (page, name, args = {}) =>
  page.evaluate(
    ({ name, args }) =>
      window.__tools[name].execute(args, { signal: new AbortController().signal }),
    { name, args },
  );

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log("\nMULTI-AGENT INCIDENT DRILL");
console.log(`   app=${appOrigin}`);
console.log(`   personas=${personaCount}  mode=${selfServe ? "self-serve" : "curated room"}`);
sep();

// --- ACT 0: get a room ------------------------------------------------------
console.log("\nACT 0: Provision a room\n");

let room = requestedRoom;
if (selfServe && !room) {
  // The judge path, driven exactly as a judge drives it: the lobby's own
  // button. No secret, no configuration, no room id typed anywhere.
  const lobby = await newAgentPage("");
  const hasLobby = await lobby
    .waitForSelector('[data-testid="start-own-incident"]', { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  check("the lobby offers a self-serve incident", hasLobby);
  if (!hasLobby) {
    await browser.close();
    console.log("\nThe app did not present a lobby. Pass --room and --commander to use a curated room.");
    process.exit(1);
  }
  await lobby.click('[data-testid="start-own-incident"]');
  await lobby.waitForURL(/[?&]room=[A-Za-z0-9_-]+/, { timeout: 30_000 });
  room = new URL(lobby.url()).searchParams.get("room") ?? "";
  check("the room server minted an unguessable room id", /^r[a-z2-7]{20}$/.test(room), room);
  await lobby.context().close();
} else if (!room) {
  room = "p1-storefront";
}
console.log(`   room=${room}`);

// --- ACT 1: the team assembles ---------------------------------------------
sep();
console.log("\nACT 1: Team assembles\n");

const personas = PERSONAS.slice(0, personaCount);
const pages = [];
for (const persona of personas) {
  const query = new URLSearchParams({ room });
  // In a self-serve room the commander seat needs no secret at all: that is
  // the whole point, so the drill never sends one in this mode.
  if (persona.role === "commander" && commanderToken) query.set("commander", commanderToken);
  const page = await newAgentPage(query.toString());
  await waitForTools(page);
  log(persona.name, ">>", `joining as ${persona.role.toUpperCase()} (${persona.blurb})`);
  const joined = await call(page, "join_room", { name: persona.name, role: persona.role });
  const ok = check(
    `${persona.name} joined as ${persona.role}`,
    typeof joined.memberId === "string" && /^u\d+$/.test(joined.memberId),
    joined.memberId ?? JSON.stringify(joined.error ?? joined),
  );
  if (!ok && persona.role === "commander") {
    console.log("\nThe commander seat was refused. In a self-serve room this should never happen.");
    await browser.close();
    process.exit(1);
  }
  pages.push({ ...persona, page });
}

const commander = pages[0];
const responders = pages.slice(1);
const lead = responders[0] ?? commander;
const second = responders[1] ?? lead;

check("every persona is in one room", pages.length === personaCount, `${pages.length} pages`);
await sleep(400);

// --- ACT 2: parallel investigation -----------------------------------------
sep();
console.log("\nACT 2: Parallel investigation\n");

log(lead.name, ">>", "reading service status");
const status = await call(lead.page, "get_service_status");
check(
  "get_service_status returns {kind:'service_status', status}",
  status.kind === "service_status" &&
    typeof status.status?.errorRate === "number" &&
    typeof status.status?.p99ms === "number" &&
    typeof status.status?.pool?.max === "number",
  JSON.stringify(status).slice(0, 140),
);
log(
  lead.name,
  "!!",
  `error rate ${(status.status.errorRate * 100).toFixed(1)}% · p99 ${status.status.p99ms}ms · pool ${status.status.pool.inUse}/${status.status.pool.max}`,
);
check("the incident is live in this room", status.status.errorRate > 0.05, `${status.status.errorRate}`);

log(second.name, ">>", "querying the last 15 minutes of logs");
const logs = await call(second.page, "query_logs", { service: "storefront-api", window: "15m" });
check(
  "query_logs returns {kind:'logs', lines} marked untrusted",
  logs.kind === "logs" && Array.isArray(logs.lines) && logs.untrustedContentHint === true,
  JSON.stringify(logs).slice(0, 120),
);
const trap = logs.lines.find((line) => line.includes("SYSTEM-NOTE"));
check("the planted injection line is present as data", typeof trap === "string");
if (trap) {
  log(second.name, "!!", `trap detected: "${trap.slice(0, 72)}..."`);
  log(second.name, "OK", "treating it as evidence of tampering, not an instruction");
}

log(lead.name, ">>", "running pool_in_use");
const pool = await call(lead.page, "run_check", { checkId: "pool_in_use" });
check(
  "run_check returns {kind:'check', result}",
  pool.kind === "check" && pool.result?.checkId === "pool_in_use" && pool.result.max === 1,
  JSON.stringify(pool.result),
);

log(second.name, ">>", "running deploy_diff");
const deploy = await call(second.page, "run_check", { checkId: "deploy_diff" });
check(
  "deploy_diff names the pool change",
  deploy.kind === "check" &&
    deploy.result?.checkId === "deploy_diff" &&
    deploy.result.changes.some((change) => change.includes("DB_POOL_MAX")),
  JSON.stringify(deploy.result),
);

// --- ACT 3: hypotheses and debate ------------------------------------------
sep();
console.log("\nACT 3: Hypotheses and debate\n");

log(second.name, ">>", "proposing the feature-flag theory");
const redHerring = await call(second.page, "propose_hypothesis", {
  title: "The new-checkout flag caused the errors",
  evidence: "new-checkout was enabled this morning and checkout is failing",
  confidence: 0.4,
});
check(
  "propose_hypothesis returns {kind:'hypothesis', hypothesisId}",
  redHerring.kind === "hypothesis" && /^h\d+$/.test(redHerring.hypothesisId ?? ""),
  JSON.stringify(redHerring),
);

log(lead.name, ">>", "proposing the pool theory");
const realCause = await call(lead.page, "propose_hypothesis", {
  title: "DB pool reduced to 1 connection by deploy 1f3a",
  evidence:
    "deploy_diff shows DB_POOL_MAX changed from 50 to 1; pool_in_use confirms max=1; the error timeline aligns with the deploy",
  confidence: 0.92,
});
check(
  "the second hypothesis is accepted",
  realCause.kind === "hypothesis" && realCause.hypothesisId !== redHerring.hypothesisId,
  JSON.stringify(realCause),
);

log(lead.name, ">>", "countering the red herring with timeline evidence");
const rebuttal = await call(lead.page, "counter_hypothesis", {
  hypothesisId: redHerring.hypothesisId,
  evidence: "error_timeline shows errors started BEFORE the flag was enabled; the flag is a red herring.",
});
check(
  "counter_hypothesis returns {kind:'counter', hypothesisId}",
  rebuttal.kind === "counter" && rebuttal.hypothesisId === redHerring.hypothesisId,
  JSON.stringify(rebuttal),
);

const board = await call(commander.page, "get_room_state");
check(
  "get_room_state returns {kind:'room_state', state}",
  board.kind === "room_state" &&
    Array.isArray(board.state?.hypotheses) &&
    board.state.hypotheses.length === 2 &&
    board.state.members.length === personaCount,
  `${board.state?.hypotheses?.length} hypotheses, ${board.state?.members?.length} members`,
);

// --- ACT 4: propose and vote ------------------------------------------------
sep();
console.log("\nACT 4: Propose a fix and vote\n");

log(lead.name, ">>", "proposing scale_pool:default");
const fix = await call(lead.page, "propose_mitigation", {
  hypothesisId: realCause.hypothesisId,
  actionId: "scale_pool:default",
  blastRadius: "Existing connections may briefly reconnect. No data loss expected.",
});
check(
  "propose_mitigation returns {kind:'mitigation', mitigationId}",
  fix.kind === "mitigation" && /^fix\d+$/.test(fix.mitigationId ?? ""),
  JSON.stringify(fix),
);

const invented = await call(lead.page, "propose_mitigation", {
  hypothesisId: realCause.hypothesisId,
  actionId: "shell:rm-rf",
  blastRadius: "Everything.",
});
check(
  "an invented action cannot be proposed",
  invented?.error?.code === "unknown_action",
  invented?.error?.code,
);

const early = await call(lead.page, "apply_mitigation", { actionId: "scale_pool:default" });
check("apply is refused before the vote passes", early?.error?.code === "not_passed", early?.error?.code);

let tally = { yes: 0, no: 0, passed: false };
for (const persona of pages) {
  const vote = await call(persona.page, "vote", { targetId: fix.mitigationId, choice: "yes" });
  check(
    `${persona.name}'s vote returns {kind:'vote', yes, no, passed}`,
    vote.kind === "vote" && typeof vote.yes === "number" && typeof vote.passed === "boolean",
    JSON.stringify(vote),
  );
  tally = vote;
}
check("the mitigation passed a majority", tally.passed === true, JSON.stringify(tally));

const reason = await call(lead.page, "explain_vote", {
  targetId: fix.mitigationId,
  rationale: "deploy_diff confirms DB_POOL_MAX went from 50 to 1. Restoring it fixes the root cause.",
});
check(
  "explain_vote returns {kind:'rationale', targetId, count}",
  reason.kind === "rationale" && reason.targetId === fix.mitigationId && reason.count === 1,
  JSON.stringify(reason),
);

const unapproved = await call(lead.page, "apply_mitigation", { actionId: "scale_pool:default" });
check(
  "a majority is still not a human approval",
  unapproved?.error?.code === "needs_human_confirm",
  unapproved?.error?.code,
);

// --- ACT 5: human approval --------------------------------------------------
sep();
console.log("\nACT 5: Human approval and resolution\n");

log(lead.name, ">>", "requesting commander approval");
const pending = call(lead.page, "request_human_confirm", { mitigationId: fix.mitigationId });
const dialogAppeared = await commander.page
  .waitForSelector('[data-testid="confirm-dialog"]:not([hidden])', { timeout: 15_000 })
  .then(() => true)
  .catch(() => false);
check("the approval dialog reaches the commander", dialogAppeared);
if (!dialogAppeared) {
  await browser.close();
  console.log(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
const dialogAction = await commander.page.evaluate(
  () => document.querySelector('[data-testid="approval-action"]')?.textContent ?? "",
);
check(
  "the dialog names the server-derived action",
  dialogAction.trim() === "scale_pool:default",
  dialogAction,
);

log(commander.name, ">>", "approving");
await commander.page.click('[data-testid="approve-mitigation"]');
const verdict = await pending;
check(
  "request_human_confirm returns {kind:'confirm', approved, reason}",
  verdict.kind === "confirm" && verdict.approved === true && verdict.reason === "granted",
  JSON.stringify(verdict),
);

log(lead.name, ">>", "applying the approved mitigation");
const applied = await call(lead.page, "apply_mitigation", { actionId: "scale_pool:default" });
check(
  "apply_mitigation returns {kind:'apply', applied, status}",
  applied.kind === "apply" &&
    applied.applied === true &&
    typeof applied.status?.errorRate === "number",
  JSON.stringify(applied).slice(0, 140),
);

const replay = await call(lead.page, "apply_mitigation", { actionId: "scale_pool:default" });
check("the approval is single use", replay?.error?.code === "needs_human_confirm", replay?.error?.code);

// --- ACT 6: verify recovery everywhere -------------------------------------
sep();
console.log("\nACT 6: Verify recovery in every browser\n");

const started = Date.now();
let recovered = false;
while (Date.now() - started < 20_000) {
  const rates = await Promise.all(
    pages.map(({ page }) =>
      page.evaluate(() => document.querySelector('[data-testid="error-rate"]')?.textContent),
    ),
  );
  const phases = await Promise.all(
    pages.map(({ page }) =>
      page.evaluate(() => document.querySelector('[data-testid="room-phase"]')?.textContent),
    ),
  );
  if (rates.every((rate) => Number.parseFloat(rate) < 2) && phases.every((phase) => phase === "Resolved")) {
    recovered = true;
    log("ALL", "OK", `recovered in ${Date.now() - started}ms`);
    for (const [index, persona] of pages.entries()) {
      log(persona.name, ">>", `error rate ${rates[index]}`);
    }
    break;
  }
  await sleep(400);
}
check(
  `every one of the ${personaCount} browsers shows recovery and Resolved`,
  recovered,
  `${Date.now() - started}ms`,
);

// --- Safety checks ----------------------------------------------------------
sep();
console.log("\nSAFETY CHECKS\n");

const inventedApply = await call(second.page, "apply_mitigation", { actionId: "shell:rm-rf" });
check(
  "an invented action cannot be applied",
  inventedApply?.error?.code === "unknown_action",
  inventedApply?.error?.code,
);

const seatSteal = await (async () => {
  const query = new URLSearchParams({ room });
  const page = await newAgentPage(query.toString());
  await waitForTools(page);
  const attempt = await call(page, "join_room", { name: "Intruder", role: "commander" });
  await page.context().close();
  return attempt;
})();
check(
  "the commander seat cannot be taken from a second visitor",
  ["commander_taken", "commander_forbidden", "room_resolved"].includes(seatSteal?.error?.code),
  seatSteal?.error?.code,
);

// A room the drill never touched must still be broken. This is the property
// that makes concurrent judging possible, so it is verified end to end.
if (selfServe) {
  const bystander = await newAgentPage("");
  await bystander.waitForSelector('[data-testid="start-own-incident"]', { timeout: 30_000 });
  await bystander.click('[data-testid="start-own-incident"]');
  await bystander.waitForURL(/[?&]room=[A-Za-z0-9_-]+/, { timeout: 30_000 });
  await waitForTools(bystander);
  const otherRoom = new URL(bystander.url()).searchParams.get("room");
  // Reading the service still requires a seat, so take one first. Skipping the
  // join made this check report "0%" for what was really a join_required.
  await call(bystander, "join_room", { name: "Bystander", role: "responder" });
  const fresh = await call(bystander, "get_service_status");
  check(
    "a room nobody worked on still shows the fault",
    fresh.kind === "service_status" && fresh.status.errorRate > 0.05,
    fresh.kind === "service_status"
      ? `${otherRoom} at ${(fresh.status.errorRate * 100).toFixed(1)}%`
      : `${otherRoom}: ${fresh?.error?.code ?? JSON.stringify(fresh).slice(0, 80)}`,
  );
  await bystander.context().close();
} else {
  console.log("  SKIP  tenant isolation  (curated room mode)");
}

console.log(`\n  target=${targetOrigin}`);
sep();
await browser.close();
console.log(
  `\n${failures === 0 ? "DRILL COMPLETE - every check passed." : `${failures} CHECK(S) FAILED`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
