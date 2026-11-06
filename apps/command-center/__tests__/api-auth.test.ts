import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const readSession = vi.fn();
vi.mock("@/lib/session", () => ({
  SESSION_COOKIE_NAME: "cc_session",
  readSession: (id: string | undefined) => readSession(id),
}));

const refreshCard = vi.fn();
vi.mock("@/lib/cards", async (orig) => ({
  ...(await orig<typeof import("@/lib/cards")>()),
  refreshCard: (name: string) => refreshCard(name),
}));

const loadTodos = vi.fn();
vi.mock("@/lib/todos", async (orig) => ({
  ...(await orig<typeof import("@/lib/todos")>()),
  loadTodos: () => loadTodos(),
}));

const { requireApiSession } = await import("@/lib/api-auth");

const API_DIR = fileURLToPath(new URL("../app/api", import.meta.url));
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
/** Routes that are deliberately not session-gated (and why). */
const PUBLIC = new Set([
  "health/route.ts", // uptime checks; returns a static "ok"
  "snapshots/warm/route.ts", // Vercel cron, Bearer CRON_SECRET (tested below)
]);

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? routeFiles(join(dir, e.name)) : e.name === "route.ts" ? [join(dir, e.name)] : [],
  );
}

type Handler = (req: NextRequest) => Promise<Response>;

function req(path: string, method = "GET", cookie?: string): NextRequest {
  return new NextRequest(`https://hq.example.com${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie: `cc_session=${cookie}` } : {}) },
    ...(method === "GET" ? {} : { body: "{}" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

describe("requireApiSession", () => {
  it("returns 401 with no cookie", async () => {
    readSession.mockResolvedValue(null);
    const res = await requireApiSession(req("/api/items"));
    expect(res?.status).toBe(401);
    expect(readSession).toHaveBeenCalledWith(undefined);
  });

  it("returns 401 for a cookie with no live session", async () => {
    readSession.mockResolvedValue(null);
    const res = await requireApiSession(req("/api/items", "GET", "stale"));
    expect(res?.status).toBe(401);
    expect(readSession).toHaveBeenCalledWith("stale");
  });

  it("returns null for a valid session", async () => {
    readSession.mockResolvedValue({ email: "matt@example.com" });
    expect(await requireApiSession(req("/api/items", "GET", "good"))).toBeNull();
  });
});

describe("every /api route re-checks the session", () => {
  const files = routeFiles(API_DIR)
    .map((f) => relative(API_DIR, f))
    .filter((f) => !PUBLIC.has(f));

  it("finds the gated routes", () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
  });

  for (const file of files) {
    it(`${file} returns 401 for every method without a session`, async () => {
      readSession.mockResolvedValue(null);
      const mod = (await import(join(API_DIR, file))) as Partial<Record<(typeof METHODS)[number], Handler>>;
      const methods = METHODS.filter((m) => typeof mod[m] === "function");
      expect(methods.length).toBeGreaterThan(0);
      for (const m of methods) {
        const res = await mod[m]!(req(`/api/${file.replace(/\/?route\.ts$/, "")}`, m, "forged"));
        expect(res.status, `${m} ${file}`).toBe(401);
      }
    });
  }

  it("lets a signed-in request through", async () => {
    readSession.mockResolvedValue({ email: "matt@example.com" });
    loadTodos.mockResolvedValue([{ id: "1", status: "pending" }]);
    const { GET } = await import("@/app/api/todos/route");
    const res = await GET(req("/api/todos", "GET", "good"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: "1", status: "pending" }]);
  });
});

describe("/api/snapshots/warm stays on its cron bearer", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "cron-secret";
    refreshCard.mockResolvedValue({ fetchedAt: "2026-11-05T00:00:00Z" });
  });

  it("rejects a missing or wrong bearer", async () => {
    const { GET } = await import("@/app/api/snapshots/warm/route");
    expect((await GET(new Request("https://hq.example.com/api/snapshots/warm"))).status).toBe(401);
    const wrong = new Request("https://hq.example.com/api/snapshots/warm", { headers: { authorization: "Bearer nope" } });
    expect((await GET(wrong)).status).toBe(401);
    const lower = new Request("https://hq.example.com/api/snapshots/warm", { headers: { authorization: "bearer cron-secret" } });
    expect((await GET(lower)).status).toBe(401);
    expect(refreshCard).not.toHaveBeenCalled();
  });

  it("fails closed when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    const { GET } = await import("@/app/api/snapshots/warm/route");
    const req = new Request("https://hq.example.com/api/snapshots/warm", { headers: { authorization: "Bearer undefined" } });
    expect((await GET(req)).status).toBe(401);
    expect((await GET(new Request("https://hq.example.com/api/snapshots/warm"))).status).toBe(401);
    expect(refreshCard).not.toHaveBeenCalled();
  });

  it("runs with the bearer and no session", async () => {
    const { GET } = await import("@/app/api/snapshots/warm/route");
    const ok = new Request("https://hq.example.com/api/snapshots/warm", {
      headers: { authorization: "Bearer cron-secret" },
    });
    expect((await GET(ok)).status).toBe(200);
    expect(refreshCard).toHaveBeenCalled();
    expect(readSession).not.toHaveBeenCalled();
  });
});
