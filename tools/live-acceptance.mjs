// Drive the whole incident against real Workers through real browser pages.
//
// The automated suite runs an in-process protocol harness; this script runs the
// same journey against `wrangler dev` (or a deployed origin), so the room
// Worker, the Durable Object, and the target Worker are the real ones. The
// commander approval is a real click on the real dialog.
//
// By default it takes the judge's path: open the app, click "Start my own
// incident", and let the first claimer take the commander seat with no secret.
// `--room <id> --commander <token>` runs the curated room instead.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Mirrors TOOL_NAMES.length in shared/tools.ts. This file runs under a bare
// `node`, which cannot import the TypeScript contract; a unit test asserts the
// two never drift apart.
const EXPECTED_TOOLS = 13;

// Mirrors shared/tenancy.ts. This file is plain .mjs so it can run under a bare
// `node`, which cannot import the TypeScript source. A unit test asserts the
// two never drift apart.
const TENANT_HEADER = "X-Multicom-Tenant";

// Resolve repo paths from this file, so the script works from any directory.
const repo = (relative) => fileURLToPath(new URL(`../${relative}`, import.meta.url));

const arg = (flag, fallback) => {
  const at = process.argv.indexOf(flag);
  return at === -1 ? fallback : process.argv[at + 1];
};

const appOrigin = arg("--app", "http://127.0.0.1:5173");
const targetOrigin = arg("--target", "http://127.0.0.1:8788");
// Precedence: explicit flag, then the file the rotation writes, then the
// environment. Anything that is not 32 hex bytes is not a token, so a
// leftover placeholder reads as "absent" rather than "rejected".
const requestedRoom = arg("--room", "");
// A curated room needs the shared secret. A room the lobby mints does not, and
// that is the path a judge takes, so it is the default. `--room` is what opts
// in: a `.commander-token` sitting on disk must not silently change modes.
const curated = Boolean(requestedRoom);
const looksLikeToken = (value) => /^[0-9a-f]{64}$/.test(value ?? "");
const tokenFromFile = curated
  ? await readFile(repo(".commander-token"), "utf8")
      .then((raw) => raw.trim())
      .catch(() => "")
  : "";
const supplied = curated
  ? arg("--commander", "") || tokenFromFile || process.env.COMMANDER_TOKEN || ""
  : "";
if (supplied && !looksLikeToken(supplied)) {
  console.log(`ignoring a commander value that is not 32 hex bytes (${supplied.length} chars)`);
  console.log("Mint one with: npm run token:commander");
}
const commanderToken = looksLikeToken(supplied) ? supplied : "";

let failures = 0;
let skipped = 0;
const check = (label, pass, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!pass) failures += 1;
  return pass;
};
const skip = (label, why) => {
  console.log(`SKIP  ${label}  ${why}`);
  skipped += 1;
};

const browser = await chromium.launch({ headless: true });

const newContextPage = async () => {
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
  return page;
};

const waitForTools = (page) =>
  page.waitForFunction(
    (expected) => Object.keys(window.__tools ?? {}).length === expected,
    EXPECTED_TOOLS,
    { timeout: 30_000 },
  );

/** Provision a room through the lobby, the way a judge does. */
async function mintRoomThroughLobby() {
  const page = await newContextPage();
  await page.goto(`${appOrigin}/`);
  await page.waitForSelector('[data-testid="start-own-incident"]', { timeout: 30_000 });
  await page.click('[data-testid="start-own-incident"]');
  // Race the navigation against the lobby's own error line, so a refused mint
  // (a rate limit, an unreachable room server) reads as the reason rather than
  // as a bare selector timeout.
  const outcome = await Promise.race([
    page.waitForURL(/[?&]room=[A-Za-z0-9_-]+/, { timeout: 30_000 }).then(() => "navigated"),
    page
      .waitForSelector(".mc-path__status:not([hidden])", { timeout: 30_000 })
      .then((node) => node.textContent()),
  ]).catch(() => "timed out waiting for the lobby");
  if (outcome !== "navigated") {
    await page.context().close();
    throw new Error(`the lobby refused to provision a room: ${outcome}`);
  }
  const minted = new URL(page.url()).searchParams.get("room") ?? "";
  await page.context().close();
  return minted;
}

const call = (page, name, args = {}) =>
  page.evaluate(
    ({ name, args }) =>
      window.__tools[name].execute(args, { signal: new AbortController().signal }),
    { name, args },
  );

/** The target's view of one room, read straight from the scripted service. */
const tenantStatus = (roomId) =>
  fetch(`${targetOrigin}/status`, { headers: { [TENANT_HEADER]: roomId } }).then((response) =>
    response.json(),
  );

console.log(`app=${appOrigin}\ntarget=${targetOrigin}\nmode=${curated ? "curated room" : "self-serve"}\n`);

let room = requestedRoom;
if (!curated) {
  room = await mintRoomThroughLobby();
  check("the lobby mints an unguessable room id", /^r[a-z2-7]{20}$/.test(room), room);
  // A freshly minted room gets its own scenario object, armed by construction.
  const fresh = await tenantStatus(room);
  check("a new room starts with the fault armed", fresh.errorRate > 0.05, `${fresh.errorRate}`);
} else {
  // The curated room is one shared scenario, so a previous run leaves it
  // healthy. Re-arm it, scoped to that room, or this pass grades a recovered
  // service.
  const status = await tenantStatus(room);
  if (status.errorRate >= 0.02) {
    console.log("fault: already armed");
  } else {
    const raw = await readFile(repo("target/.dev.vars"), "utf8").catch(() => "");
    const marker = "ADMIN_KEY=";
    const at = raw.indexOf(marker);
    const key = at === -1
      ? ""
      : raw.slice(at + marker.length).split(String.fromCharCode(10))[0].trim().replace(/^"|"$/g, "");
    if (!key) {
      console.log("fault: service is healthy and no local ADMIN_KEY was found - re-arm it by hand");
    } else {
      const response = await fetch(
        `${targetOrigin}/admin/fault?on=1&key=${encodeURIComponent(key)}`,
        { method: "POST", headers: { [TENANT_HEADER]: room } },
      );
      console.log(`fault: ${response.ok ? "re-armed" : `re-arm failed (${response.status})`}`);
    }
  }
}
console.log(`room=${room}\n`);

const openPage = async (isCommander) => {
  const page = await newContextPage();
  const query = new URLSearchParams({ room });
  if (isCommander && curated) query.set("commander", commanderToken);
  await page.goto(`${appOrigin}/?${query.toString()}`);
  await waitForTools(page);
  return page;
};

const commander = await openPage(true);
const alice = await openPage(false);
const bob = await openPage(false);
check(`${EXPECTED_TOOLS} tools register on the real page`, true);

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
  call(commander, "join_room", { name: "Priya", role: "commander" }),
  call(alice, "join_room", { name: "Arjun", role: "responder" }),
  call(bob, "join_room", { name: "Mei", role: "responder" }),
]);
const commanderJoin = joins[0];
if (commanderJoin?.error) {
  console.log(`\nThe commander seat was refused: ${commanderJoin.error.code}.`);
  if (curated) {
    console.log("COMMANDER_TOKEN does not match the value on the deployed room Worker.");
    console.log("Check for a stale value in this shell, or rotate: npm run token:commander");
  } else {
    console.log("A self-serve room should seat its first claimer with no secret at all.");
    console.log("Check that the deployed room Worker is the build with per-room provisioning.");
  }
  await browser.close();
  process.exit(1);
}
check("three members joined the real Durable Object", joins.every((join) => join.memberId), joins.map((join) => join.memberId ?? join.error?.code).join(","));

// A second visitor must not be able to take the seat that gates approval.
const stealPage = await openPage(false);
const steal = await call(stealPage, "join_room", { name: "Intruder", role: "commander" });
check(
  "commander seat refused to a second visitor",
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
  console.log(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
const dialogAction = await commander.evaluate(
  () => document.querySelector('[data-testid="approval-action"]')?.textContent ?? "",
);
check("dialog names the server-derived action", dialogAction.trim() === "scale_pool:default", dialogAction);
const dialogText = await commander.evaluate(() => document.querySelector('[data-testid="confirm-dialog"]').innerText);
check("dialog shows who voted and why", dialogText.includes("Mei voted yes") && dialogText.includes("DB_POOL_MAX"));
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
  if (rates.every((rate) => Number.parseFloat(rate) < 2) && phases.every((phase) => phase === "Resolved")) { recovered = true; break; }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
check("every browser shows recovery and Resolved within 15s", recovered, `${Date.now() - started}ms`);

// The judge console has to be usable as an artefact, not just present. This
// script drives a specific run, so the exact rows it should have earned are
// known — and the rows it should NOT have earned matter just as much.
const rubric = await commander
  .evaluate(() => {
    document.querySelector('[data-testid="toggle-judge-console"]')?.click();
    const rows = [...document.querySelectorAll('[data-testid="judge-rubric"] [data-rubric-id]')];
    return Object.fromEntries(rows.map((row) => [row.dataset.rubricId, row.dataset.passed === "true"]));
  })
  .catch(() => ({}));
const earned = [
  "multiplayer",
  "tool-surface",
  "evidence-first",
  "challenged",
  "majority-vote",
  "human-approval",
  "verified-recovery",
];
check(
  "the judge console ticks every row this run earned",
  Object.keys(rubric).length === 10 && earned.every((id) => rubric[id] === true),
  earned.filter((id) => rubric[id] !== true).join(",") || `${Object.keys(rubric).length} rows`,
);
// This run never posted the flag theory, and the commander's own browser never
// read the logs or replayed an apply, so those rows must stay unticked. A
// console that ticked them would be reporting hearsay.
const unearned = ["red-herring", "injection", "single-use-approval"];
check(
  "the judge console leaves rows this browser did not witness untouched",
  unearned.every((id) => rubric[id] === false),
  unearned.filter((id) => rubric[id] !== false).join(",") || "none ticked",
);

// The property that makes concurrent judging possible, verified against the
// real target: a room nobody worked on is untouched by this recovery.
if (!curated) {
  const bystanderRoom = await mintRoomThroughLobby();
  const bystander = await tenantStatus(bystanderRoom);
  check(
    "another room's incident is untouched by this recovery",
    bystander.errorRate > 0.05 && bystanderRoom !== room,
    `${bystanderRoom} at ${(bystander.errorRate * 100).toFixed(1)}%`,
  );
  const resolvedRoom = await tenantStatus(room);
  check(
    "this room's own scenario really did recover",
    resolvedRoom.errorRate < 0.02,
    `${(resolvedRoom.errorRate * 100).toFixed(1)}%`,
  );
} else {
  skip("tenant isolation", "curated room mode shares one scenario by design");
}

// Fail-closed checks, straight against the Workers rather than through a page.
// The browser can only ever send an allowed origin, so these are the only way
// to prove the room refuses everything else — and provisioning is a new route
// with its own origin handling, so it gets the same treatment as the upgrade.
// Taken from the page's own room client rather than configured again, so these
// checks always hit the room server the app is actually talking to.
const roomOrigin = await commander.evaluate(() => location.origin);
const roomServerOrigin =
  arg("--room-server", "") ||
  (await commander.evaluate(() => {
    const client = globalThis[Symbol.for("multicom.room-client")];
    if (!client) return "";
    const url = new URL(client.url);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    return url.origin;
  }));
if (!roomServerOrigin) {
  check("the room server origin is discoverable from the page", false, "pass --room-server");
}
const provision = (headers) =>
  fetch(new URL("/rooms", roomServerOrigin), { method: "POST", headers }).then((response) => response.status);

const noOrigin = await provision({});
check("room provisioning refuses a request with no Origin", noOrigin === 403, String(noOrigin));
const wrongOrigin = await provision({ origin: "https://evil.invalid" });
check("room provisioning refuses an unknown Origin", wrongOrigin === 403, String(wrongOrigin));
const allowedProvision = await fetch(new URL("/rooms", roomServerOrigin), {
  method: "POST",
  headers: { origin: roomOrigin },
});
check(
  "room provisioning answers an allow-listed Origin with the exact CORS header",
  allowedProvision.status === 200 &&
    allowedProvision.headers.get("access-control-allow-origin") === roomOrigin,
  `${allowedProvision.status} ${allowedProvision.headers.get("access-control-allow-origin")}`,
);

// The origin gate runs before the upgrade check, so a plain GET separates the
// two: an unknown origin is refused outright, and an allowed one gets as far as
// being told it needs a WebSocket. `fetch` cannot send `Upgrade`/`Connection`
// itself — they are forbidden headers — and it does not need to.
const wsPath = new URL(`/rooms/${encodeURIComponent(room)}/ws`, roomServerOrigin);
const strangerUpgrade = await fetch(wsPath, { headers: { origin: "https://evil.invalid" } });
check(
  "the room refuses an unknown Origin before looking at the upgrade",
  strangerUpgrade.status === 403,
  String(strangerUpgrade.status),
);
const allowedUpgrade = await fetch(wsPath, { headers: { origin: roomOrigin } });
check(
  "an allow-listed Origin gets past the gate and is asked to upgrade",
  allowedUpgrade.status === 426,
  String(allowedUpgrade.status),
);

const badTenant = await fetch(`${targetOrigin}/status`, {
  headers: { [TENANT_HEADER]: "../etc/passwd" },
});
check(
  "the target refuses a tenant header that is not a room id",
  badTenant.status === 400,
  String(badTenant.status),
);

await browser.close();
console.log(
  `\n${failures === 0 ? `ALL CHECKS PASSED${skipped ? ` (${skipped} skipped)` : ""}` : `${failures} CHECK(S) FAILED`}`,
);
process.exit(failures === 0 ? 0 : 1);
