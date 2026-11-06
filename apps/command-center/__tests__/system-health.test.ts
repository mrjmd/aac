/**
 * lib/system-health.ts reads only Redis (and the saved CI snapshot): no
 * GitHub or middleware call on page load. The CI source is read only by
 * the snapshot refresh.
 */
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  strings: new Map<string, unknown>(),
  hashes: new Map<string, Record<string, unknown>>(),
  lists: new Map<string, unknown[]>(),
}));
const redis = vi.hoisted(() => ({
  get: vi.fn(async (k: string) => store.strings.get(k) ?? null),
  hgetall: vi.fn(async (k: string) => store.hashes.get(k) ?? null),
  lrange: vi.fn(async (k: string, a: number, b: number) => (store.lists.get(k) ?? []).slice(a, b + 1)),
  llen: vi.fn(async (k: string) => (store.lists.get(k) ?? []).length),
}));
vi.mock("@/lib/redis", () => ({ getRedis: () => redis }));
vi.mock("next/server", () => ({ after: vi.fn() }));

import { fetchCiStatus, loadSystemCandidates, readMiddlewareHealth, readSystemHealth } from "@/lib/system-health";

const NOW = new Date("2026-11-05T16:00:00Z"); // 11am ET
const fetchSpy = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  store.strings.clear();
  store.hashes.clear();
  store.lists.clear();
  vi.clearAllMocks();
  fetchSpy.mockReset();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  delete process.env.GITHUB_TOKEN;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function saveCi(data: unknown) {
  store.strings.set("cc:snap:system:ci", gzipSync(JSON.stringify({ data, fetchedAt: NOW.toISOString() })).toString("base64"));
}

describe("readSystemHealth", () => {
  it("assembles watchdog, signals, counts, jobs, errors and CI from Redis only", async () => {
    store.hashes.set("watchdog:state", {
      "gemini-degraded": { since: "2026-11-05T15:30:00Z", firstSeenAt: "2026-11-05T15:30:00Z", ticks: 3, alertedAt: "2026-11-05T15:35:00Z" },
    });
    store.strings.set("health:watchdog:ts", "2026-11-05T15:58:00Z");
    store.strings.set("cron:invoice-create:last-run", "2026-11-04T11:00:00Z"); // 29h: late
    store.strings.set("cron:invoice-create:2026-11-05:result", { sent: 2, skipped: 1, errors: 0 });
    store.hashes.set("health:conditions:2026-11-05", { "invoice-create.no_qb_customer": 1, "reminders.no_phone": "2" });
    store.hashes.set("health:conditions:2026-11-03", { "reminders.no_phone": 1 });
    store.hashes.set("health:conditions:2026-11-05:entities", {
      "invoice-create.no_qb_customer|evt1": { label: "Jane · 1 Elm · 2026-11-05", at: "2026-11-05T11:00:01Z" },
    });
    store.lists.set("health:errors", [
      JSON.stringify({ source: "worker:sweep", message: "boom", commitSha: "x", timestamp: "2026-11-05T15:00:00Z" }),
      { source: "qb-reconcile", message: "qbo 500", details: { estimateId: 9 }, commitSha: "x", timestamp: "2026-11-05T14:00:00Z" },
    ]);
    saveCi({ configured: false, envVar: "GITHUB_TOKEN", runs: [] });

    const h = await readSystemHealth(NOW);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.watchdog).toEqual([expect.objectContaining({ id: "gemini-degraded", ticks: 3 })]);
    const sig = (kind: string, name: string) => h.signals.find((s) => s.kind === kind && s.name === name)!;
    expect(sig("heartbeat", "watchdog").level).toBe("green");
    expect(sig("cron", "invoice-create")).toMatchObject({ level: "red", result: { sent: 2, skipped: 1, errors: 0 } });
    expect(sig("cron", "stale-quotes").level).toBe("gray"); // mode-gated, never ran
    expect(sig("cron", "qb-reconcile").level).toBe("red"); // required, never ran
    expect(h.conditions).toEqual([
      { name: "reminders.no_phone", label: expect.stringContaining("reminder"), today: 2, week: 3 },
      { name: "invoice-create.no_qb_customer", label: expect.stringContaining("not invoiced"), today: 1, week: 1 },
    ]);
    expect(h.jobs).toEqual([expect.objectContaining({ id: "evt1", label: "Jane · 1 Elm · 2026-11-05" })]);
    expect(h.errors.map((e) => e.source)).toEqual(["worker:sweep", "qb-reconcile"]);
    expect(h.errorCount).toBe(2);
    expect(h.ci.snap?.data.configured).toBe(false);
    expect(h.ci.verdict.state).toBe("unknown");
    // The middleware card leaves worker errors to the worker rows.
    expect(h.middleware.metrics?.errors.map((e) => e.source)).toEqual(["qb-reconcile"]);
    expect(h.middleware.metrics?.errors[0].details).toEqual({ estimateId: "9" });
  });
});

describe("readMiddlewareHealth", () => {
  it("sums today's and yesterday's webhook counts and reads last-processed", async () => {
    store.strings.set("webhooks:quo:2026-11-05:count", 4);
    store.strings.set("webhooks:quo:2026-11-04:count", "3");
    store.strings.set("webhooks:quo:last", "2026-11-05T15:59:00Z");
    const h = await readMiddlewareHealth(NOW);
    expect(h.status).toBe("healthy");
    expect(h.metrics?.webhooks.quo).toEqual({ processed24h: 7, lastProcessed: "2026-11-05T15:59:00Z" });
    expect(h.metrics?.webhooks.pipedrive).toEqual({ processed24h: 0, lastProcessed: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports Redis failure as unreachable instead of throwing", async () => {
    redis.get.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const h = await readMiddlewareHealth(NOW);
    expect(h).toMatchObject({ status: "unreachable", error: "Redis: ECONNREFUSED" });
  });
});

describe("loadSystemCandidates", () => {
  it("floats jobs not invoiced once 3 distinct jobs are skipped in 7 days", async () => {
    store.hashes.set("health:conditions:2026-11-05:entities", {
      "invoice-create.no_person|a": { label: "A", at: "2026-11-05T11:00:00Z" },
    });
    store.hashes.set("health:conditions:2026-11-03:entities", {
      "invoice-create.no_qb_customer|b": { label: "B", at: "2026-11-03T11:00:00Z" },
    });
    expect(await loadSystemCandidates(NOW)).toEqual([]);
    store.hashes.set("health:conditions:2026-10-30:entities", {
      "invoice-create.no_accepted_estimate|c": { label: "C", at: "2026-10-30T11:00:00Z" },
    });
    const items = await loadSystemCandidates(NOW);
    expect(items.map((i) => i.key)).toEqual(["sys:jobs-not-invoiced"]);
  });

  it("skips jobs older than 7 Eastern days", async () => {
    for (const [d, id] of [["2026-11-05", "a"], ["2026-11-04", "b"], ["2026-10-29", "old"]] as const) {
      store.hashes.set(`health:conditions:${d}:entities`, { [`invoice-create.no_person|${id}`]: { at: `${d}T11:00:00Z` } });
    }
    expect(await loadSystemCandidates(NOW)).toEqual([]);
  });

  it("floats CI when the saved snapshot shows main red twice in a row", async () => {
    const r = (n: number, conclusion: string) => ({
      id: n, number: n, sha: "s", title: `c${n}`, status: "completed", conclusion, createdAt: "2026-11-05T10:00:00Z", url: "u",
    });
    saveCi({ configured: true, envVar: "GITHUB_TOKEN", runs: [r(3, "failure"), r(2, "failure"), r(1, "success")] });
    expect((await loadSystemCandidates(NOW)).map((i) => i.key)).toEqual(["sys:ci-red"]);
  });

  it("never throws (Today must render)", async () => {
    redis.hgetall.mockRejectedValue(new Error("down"));
    await expect(loadSystemCandidates(NOW)).resolves.toEqual([]);
    redis.hgetall.mockImplementation(async (k: string) => store.hashes.get(k) ?? null);
  });
});

describe("fetchCiStatus (snapshot refresh only)", () => {
  it("says which env var to set when there's no token, without calling GitHub", async () => {
    expect(await fetchCiStatus()).toEqual({ configured: false, envVar: "GITHUB_TOKEN", runs: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reads main's CI runs and the check job's verdict up to the first green run", async () => {
    process.env.GITHUB_TOKEN = "t";
    const run = (id: number, conclusion: string) => ({
      id, run_number: id, head_branch: "main", head_sha: `abcdef${id}123`, status: "completed", conclusion,
      created_at: "2026-11-05T10:00:00Z", updated_at: "x", html_url: `run/${id}`, display_title: `c${id}`,
    });
    const jobs = (id: number, conclusion: string) => ({
      jobs: [{ id: id * 10, run_id: id, name: "check", status: "completed", conclusion, started_at: null, completed_at: null, html_url: `job/${id}`,
        steps: conclusion === "failure" ? [{ name: "Install", number: 4, status: "completed", conclusion: "success" }, { name: "Test", number: 6, status: "completed", conclusion: "failure" }] : [] }],
    });
    fetchSpy.mockImplementation(async (url: string) => {
      const body = url.includes("/workflows/ci.yml/runs")
        ? { workflow_runs: [run(3, "failure"), run(2, "success"), run(1, "failure")] }
        : url.includes("/runs/3/jobs")
          ? jobs(3, "failure")
          : jobs(2, "success");
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const s = await fetchCiStatus();
    expect(String(fetchSpy.mock.calls[0][0])).toContain("/repos/mrjmd/aac/actions/workflows/ci.yml/runs?per_page=10&branch=main");
    expect(s.runs.map((r) => [r.number, r.conclusion, r.failedStep ?? null, r.url])).toEqual([
      [3, "failure", "Test", "job/3"],
      [2, "success", null, "job/2"],
      [1, "failure", null, "run/1"], // past the first green run: no job lookup
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
