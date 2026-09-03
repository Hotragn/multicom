import { DurableObject } from "cloudflare:workers";
import { ACTION_LIBRARY, CHECK_IDS, type ActionId, type CheckId, type LogWindow } from "../../shared/tools";
import { SERVICE_NAME } from "../../shared/scenario";
import {
  INITIAL_SCENARIO,
  checkAt,
  selectLogs,
  snapshotAt,
  type PersistedScenario,
} from "./scenario-state";

interface Env {
  SCENARIO: DurableObjectNamespace<ScenarioState>;
  ADMIN_KEY?: string;
  TARGET_TOKEN?: string;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });

const isCheckId = (value: string): value is CheckId =>
  (CHECK_IDS as readonly string[]).includes(value);

const isActionId = (value: string): value is ActionId =>
  (ACTION_LIBRARY as readonly string[]).includes(value);

const isLogWindow = (value: string | null): value is LogWindow =>
  value === "5m" || value === "15m" || value === "1h";

const safeEqual = (actual: string | null, expected: string | undefined): boolean => {
  if (!actual || !expected || actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
};

export class ScenarioState extends DurableObject<Env> {
  private data: PersistedScenario = { ...INITIAL_SCENARIO };
  private readonly ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<PersistedScenario>("scenario");
      this.data = stored ?? { ...INITIAL_SCENARIO, armedAt: Date.now() };
      if (!stored) await ctx.storage.put("scenario", this.data);
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);
    const now = Date.now();

    if (request.method === "GET" && url.pathname === "/status") {
      return json(snapshotAt(this.data, now));
    }

    if (request.method === "GET" && url.pathname === "/logs") {
      const service = url.searchParams.get("service");
      const window = url.searchParams.get("window");
      const filter = url.searchParams.get("filter") ?? undefined;
      if (service !== SERVICE_NAME) return json({ error: "unknown_service" }, 400);
      if (!isLogWindow(window)) return json({ error: "invalid_window" }, 400);
      if (filter && filter.length > 100) return json({ error: "filter_too_long" }, 400);
      return json({ lines: selectLogs(window, filter), untrustedContentHint: true });
    }

    const checkMatch = /^\/checks\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && checkMatch) {
      const checkId = decodeURIComponent(checkMatch[1] ?? "");
      if (!isCheckId(checkId)) return json({ error: "unknown_check" }, 404);
      return json(checkAt(this.data, checkId, now));
    }

    const actionMatch = /^\/actions\/([^/]+)$/.exec(url.pathname);
    if (request.method === "POST" && actionMatch) {
      if (!safeEqual(request.headers.get("authorization"), this.env.TARGET_TOKEN ? `Bearer ${this.env.TARGET_TOKEN}` : undefined)) {
        return json({ error: "forbidden" }, 403);
      }
      const actionId = decodeURIComponent(actionMatch[1] ?? "");
      if (!isActionId(actionId)) return json({ error: "unknown_action" }, 404);
      this.data = { ...this.data, actionId, appliedAt: now };
      await this.ctx.storage.put("scenario", this.data);
      return json({ applied: true, status: snapshotAt(this.data, now) });
    }

    if ((request.method === "GET" || request.method === "POST") && url.pathname === "/admin/fault") {
      if (!safeEqual(url.searchParams.get("key"), this.env.ADMIN_KEY)) {
        return json({ error: "forbidden" }, 403);
      }
      const on = url.searchParams.get("on");
      if (on !== "0" && on !== "1") return json({ error: "invalid_fault_state" }, 400);
      this.data = {
        armed: on === "1",
        armedAt: now,
        actionId: null,
        appliedAt: null,
      };
      await this.ctx.storage.put("scenario", this.data);
      return json({ armed: this.data.armed, status: snapshotAt(this.data, now) });
    }

    return json({ error: "not_found" }, 404);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: SERVICE_NAME });
    }
    const id = env.SCENARIO.idFromName(SERVICE_NAME);
    return env.SCENARIO.get(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;
