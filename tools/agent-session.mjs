// One persistent WebMCP browser session per agent, driven over HTTP.
//
// Each agent gets a real page: the tool layer registers itself, the room
// WebSocket stays open, and room membership survives between calls. The agent
// sees exactly what a WebMCP client sees - tool names, descriptions and input
// schemas - and nothing about how the room is implemented.
import { createServer } from "node:http";
import { chromium } from "playwright";

// Mirrors TOOL_NAMES.length in shared/tools.ts. This file runs under a bare
// `node`, which cannot import the TypeScript contract; a unit test asserts the
// two never drift apart.
const EXPECTED_TOOLS = 13;

const arg = (flag, fallback) => {
  const at = process.argv.indexOf(flag);
  return at === -1 ? fallback : process.argv[at + 1];
};

const port = Number(arg("--port", "9101"));
const room = arg("--room", "live-drill");
const appOrigin = arg("--app", "http://127.0.0.1:5173");
const commander = arg("--commander", "");
const headed = process.argv.includes("--headed");
// "Name:role" takes the seat immediately, for a session a person will drive by
// hand: approval is a member action, so the browser has to be in the room
// before the human can approve anything.
const autoJoin = arg("--join", "");

const browser = await chromium.launch({ headless: !headed });
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
if (commander) query.set("commander", commander);
await page.goto(`${appOrigin}/?${query.toString()}`);
await page.waitForFunction(
  (expected) => Object.keys(window.__tools ?? {}).length === expected,
  EXPECTED_TOOLS,
  { timeout: 20_000 },
);

if (autoJoin) {
  const [name, role = "responder"] = autoJoin.split(":");
  const joined = await page.evaluate(
    ({ name, role }) =>
      window.__tools.join_room.execute({ name, role }, { signal: new AbortController().signal }),
    { name, role },
  );
  console.log("auto-join:", JSON.stringify(joined));
}

const listTools = () =>
  page.evaluate(() =>
    Object.values(window.__tools).map((tool) => ({
      name: tool.name,
      description: tool.description,
      annotations: tool.annotations ?? {},
      inputSchema: tool.inputSchema ?? null,
    })),
  );

const callTool = (name, args) =>
  page.evaluate(async ({ name, args }) => {
    const tool = window.__tools[name];
    if (!tool) return { error: { code: "unknown_tool", message: `No tool named ${name}.` } };
    try {
      return await tool.execute(args ?? {}, { signal: new AbortController().signal });
    } catch (error) {
      return { error: { code: "threw", message: String(error?.message ?? error) } };
    }
  }, { name, args });

const readBody = (request) =>
  new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => resolve(raw));
  });

const send = (response, status, value) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value, null, 2));
};

createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/tools") return send(response, 200, await listTools());
    if (request.method === "GET" && request.url === "/screen") {
      return send(response, 200, { text: await page.evaluate(() => document.body.innerText) });
    }
    if (request.method === "POST" && request.url === "/call") {
      const { tool, args } = JSON.parse((await readBody(request)) || "{}");
      if (!tool) return send(response, 400, { error: "Provide a tool name." });
      return send(response, 200, await callTool(tool, args));
    }
    if (request.method === "POST" && request.url === "/shutdown") {
      send(response, 200, { ok: true });
      await browser.close();
      process.exit(0);
    }
    send(response, 404, { error: "Use GET /tools, GET /screen, POST /call, POST /shutdown." });
  } catch (error) {
    send(response, 500, { error: String(error?.message ?? error) });
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`agent session ready on http://127.0.0.1:${port} (room=${room}, commander=${commander ? "yes" : "no"})`);
});
