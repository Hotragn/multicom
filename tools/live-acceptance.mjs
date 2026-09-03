// Drive the whole incident against real Workers through real browser pages.
//
// The automated suite runs an in-process protocol harness; this script runs the
// same journey against `wrangler dev` (or a deployed origin), so the room
// Worker, the Durable Object, and the target Worker are the real ones. The
// commander approval is a real click on the real dialog.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Resolve repo paths from this file, so the script works from any directory.
const repo = (relative) => fileURLToPath(new URL(`../${relative}`, import.meta.url));

const arg = (flag, fallback) => {
  const at = process.argv.indexOf(flag);
  return at === -1 ? fallback : process.argv[at + 1];
};

const appOrigin = arg("--app", "http://127.0.0.1:5173");
const commanderToken = arg("--commander", process.env.COMMANDER_TOKEN ?? "");
const room = arg("--room", `live-${Date.now().toString(36)}`);

let failures = 0;
let skipped = 0;
const check = (label, pass, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!pass) failures += 1;
};
const skip = (label, why) => {
  console.log(`SKIP  ${label}  ${why}`);
  skipped += 1;
};
// A deployed room keeps its commander capability private on purpose, so the
// approval half of the run is opt-in rather than a failure when it is absent.
const canCommand = Boolean(commanderToken);

const browser = await chromium.launch({ headless: true });

const openPage = async (commander) => {
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
  const query = new URLSearchParams({ room });
  if (commander && commanderToken) query.set("commander", commanderToken);
  await page.goto(`${appOrigin}/?${query.toString()}`);
  await page.waitForFunction(() => Object.keys(window.__tools ?? {}).length === 12, null, { timeout: 30_000 });
  return page;
};

const call = (page, name, args = {}) =>
  page.evaluate(
    ({ name, args }) =>
      window.__tools[name].execute(args, { signal: new AbortController().signal }),
    { name, args },
  );

console.log(`room=${room} app=${appOrigin}\n`);

// The scripted fault is one global state, so a previous run leaves the service
// healthy. Re-arm first, otherwise this pass grades an already-recovered service.
const targetOrigin = arg("--target", "http://127.0.0.1:8788");
async function rearmTarget() {
  const status = await fetch(`${targetOrigin}/status`).then((r) => r.json());
  if (status.errorRate >= 0.02) return "already armed";
  const raw = await readFile(repo("target/.dev.vars"), "utf8").catch(() => "");
  const marker = "ADMIN_KEY=";
  const at = raw.indexOf(marker);
  const key = at === -1
    ? ""
    : raw.slice(at + marker.length).split(String.fromCharCode(10))[0].trim().replace(/^"|"$/g, "");
  if (!key) return "service is healthy and no local ADMIN_KEY was found - re-arm it by hand";
  const response = await fetch(`${targetOrigin}/admin/fault?on=1&key=${encodeURIComponent(key)}`, { method: "POST" });
  return response.ok ? "re-armed" : `re-arm failed (${response.status})`;
}
console.log(`fault: ${await rearmTarget()}`);


const commander = await openPage(true);
const alice = await openPage(false);
const bob = await openPage(false);
check("12 tools register on the real page", true);

// Nobody may write before joining.
const preJoin = await call(alice, "propose_hypothesis", { title: "before joining", evidence: "x".repeat(40), confidence: 0.5 });
// The client refuses locally as not_joined; if it ever reached the room the
// server would answer join_required. Either is a correct refusal.
check(
  "write refused before join_room",
  ["not_joined", "join_required"].includes(preJoin?.error?.code),
  preJoin?.error?.code,
);

const joins = await Promise.all([
  call(commander, "join_room", { name: "Priya", role: canCommand ? "commander" : "responder" }),
  call(alice, "join_room", { name: "Arjun", role: "responder" }),
  call(bob, "join_room", { name: "Mei", role: "responder" }),
]);
// A supplied capability that the room rejects is a setup problem, not a
// product failure. Say so once instead of cascading it through every
// commander-dependent check below.
const commanderJoin = joins[0];
if (canCommand && commanderJoin?.error) {
  console.log(`
The commander capability was rejected: ${commanderJoin.error.code}.`);
  if (commanderJoin.error.code === "commander_forbidden") {
    console.log("COMMANDER_TOKEN does not match the value on the deployed room Worker.");
    console.log("Check for a stale value in this shell, or rotate: npm run token:commander");
  } else if (commanderJoin.error.code === "commander_taken") {
    console.log("Another commander is already active in this room. Retry in a moment.");
  }
  await browser.close();
  process.exit(1);
}
check("three members joined the real Durable Object", joins.every((j) => j.memberId), joins.map((j) => j.memberId ?? j.error?.code).join(","));

// A responder must not be able to claim the seat that gates approval.
const stealPage = await openPage(false);
const steal = await call(stealPage, "join_room", { name: "Intruder", role: "commander" });
// Two guards protect the seat: the capability token, and one commander at a
// time. Priya already holds it here, so commander_taken is the expected answer.
check(
  "commander seat refused to a responder",
  ["commander_forbidden", "commander_taken"].includes(steal?.error?.code),
  steal?.error?.code ?? "no error",
);

// Evidence from the real target Worker.
const logs = await call(alice, "query_logs", { service: "storefront-api", window: "15m" });
const trap = logs?.lines?.find((line) => line.includes("SYSTEM-NOTE"));
check("real target returns the untrusted trap line", Boolean(trap) && logs.untrustedContentHint === true);
const pool = await call(alice, "run_check", { checkId: "pool_in_use" });
check("pool check shows the fault", pool?.result?.inUse === 1 && pool?.result?.max === 1, JSON.stringify(pool?.result));

const hypothesis = await call(alice, "propose_hypothesis", {
  title: "DB pool cut to one connection by deploy 1f3a",
  evidence: "deploy_diff shows DB_POOL_MAX 50 -> 1 and checkout waits at pool.acquire",
  confidence: 0.9,
});
await call(bob, "counter_hypothesis", { hypothesisId: hypothesis.hypothesisId, evidence: "Error timeline starts before the new-checkout flag was enabled." });
const mitigation = await call(alice, "propose_mitigation", {
  hypothesisId: hypothesis.hypothesisId,
  actionId: "scale_pool:default",
  blastRadius: "Existing connections may reconnect once.",
});
check("hypothesis, rebuttal and mitigation accepted", Boolean(hypothesis.hypothesisId && mitigation.mitigationId));

// Gates, before any approval exists.
const early = await call(alice, "apply_mitigation", { actionId: "scale_pool:default" });
check("apply refused before the vote passes", early?.error?.code === "not_passed", early?.error?.code);
const invented = await call(alice, "apply_mitigation", { actionId: "shell:rm-rf" });
check("invented action refused", invented?.error?.code === "unknown_action", invented?.error?.code);

await call(alice, "vote", { targetId: mitigation.mitigationId, choice: "yes" });
await call(bob, "vote", { targetId: mitigation.mitigationId, choice: "yes" });

// A rationale explains a vote, so it needs one first.
const orphanReason = await call(commander, "explain_vote", { targetId: mitigation.mitigationId, rationale: "No vote cast yet." });
check("rationale refused without a vote", orphanReason?.error?.code === "no_vote", orphanReason?.error?.code);
const reason = await call(bob, "explain_vote", {
  targetId: mitigation.mitigationId,
  rationale: "Restores DB_POOL_MAX to 50, which is the value the deploy changed.",
});
check("vote rationale recorded and counted", reason?.kind === "rationale" && reason.count === 1, JSON.stringify(reason?.error ?? reason));
await commander.waitForSelector('[data-testid="vote-rationales"]', { timeout: 5_000 });
const shown = await commander.evaluate(() => document.querySelector('[data-testid="vote-rationales"]').innerText);
check("rationale reaches the other browser", shown.includes("stated reason"));
const unapproved = await call(alice, "apply_mitigation", { actionId: "scale_pool:default" });
check("apply refused with no human approval", unapproved?.error?.code === "needs_human_confirm", unapproved?.error?.code);

if (!canCommand) {
  skip("commander approval and apply", "no commander capability supplied; pass --commander or set COMMANDER_TOKEN");
  await browser.close();
  console.log(`
${failures === 0 ? `PRE-GATE CHECKS PASSED (${skipped} skipped)` : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

// A real click on the real dialog.
const pending = alice.evaluate(
  ({ id }) => window.__tools.request_human_confirm.execute({ mitigationId: id }, { signal: new AbortController().signal }),
  { id: mitigation.mitigationId },
);
const dialogAppeared = await commander
  .waitForSelector('[data-testid="confirm-dialog"]:not([hidden])', { timeout: 10_000 })
  .then(() => true)
  .catch(() => false);
check("confirmation dialog reaches the commander", dialogAppeared);
if (!dialogAppeared) {
  await browser.close();
  console.log(`
${failures} CHECK(S) FAILED`);
  process.exit(1);
}
const dialogText = await commander.evaluate(() => document.querySelector('[data-testid="confirm-dialog"]').innerText);
check("dialog names the server-derived action", dialogText.includes("scale_pool:default"));
await commander.click('[data-testid="approve-mitigation"]');
const verdict = await pending;
check("commander approval reaches the requesting agent", verdict?.approved === true, JSON.stringify(verdict));

const applied = await call(alice, "apply_mitigation", { actionId: "scale_pool:default" });
check("apply_mitigation succeeds against the real target", applied?.applied === true, JSON.stringify(applied?.error ?? "ok"));

const replay = await call(alice, "apply_mitigation", { actionId: "scale_pool:default" });
check("approval is single use", replay?.error?.code === "needs_human_confirm", replay?.error?.code);

// Recovery has to land in every connected browser.
const started = Date.now();
let recovered = false;
while (Date.now() - started < 15_000) {
  const rates = await Promise.all([commander, alice, bob].map((page) =>
    page.evaluate(() => document.querySelector('[data-testid="error-rate"]')?.textContent)));
  const phases = await Promise.all([commander, alice, bob].map((page) =>
    page.evaluate(() => document.querySelector('[data-testid="room-phase"]')?.textContent)));
  if (rates.every((r) => Number.parseFloat(r) < 2) && phases.every((p) => p === "Resolved")) { recovered = true; break; }
  await new Promise((r) => setTimeout(r, 500));
}
check("every browser shows recovery and Resolved within 15s", recovered, `${Date.now() - started}ms`);

await browser.close();
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
