import { describe, expect, it } from "vitest";
import {
  CI_RED_ONGOING_HOURS,
  ciVerdict,
  jobsNotInvoicedOngoing,
  JOBS_NOT_INVOICED_ONGOING,
  skippedJobs,
  sumConditions,
  systemCandidates,
  type CiRun,
  type CiStatus,
} from "@/lib/system-rules";

const NOW = new Date("2026-11-05T16:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe("sumConditions", () => {
  it("adds numeric and string counts across days and skips junk", () => {
    expect(sumConditions([{ "a.x": 2, "b.y": "3" }, null, { "a.x": "1", "c.z": "nope" }])).toEqual({ "a.x": 3, "b.y": 3 });
  });
});

describe("skippedJobs", () => {
  it("keeps only invoice-create.* entities, one row per job (latest reason), newest first", () => {
    const jobs = skippedJobs([
      {
        day: "2026-11-05",
        hash: {
          "invoice-create.no_accepted_estimate|evt2": { label: "Jane · 1 Elm", at: "2026-11-05T11:00:05Z" },
          "pd-webhook.lost_lock_no_contact|77": { label: "PD 77", at: "2026-11-05T11:00:00Z" },
        },
      },
      {
        day: "2026-11-04",
        hash: {
          "invoice-create.no_qb_customer|evt1": JSON.stringify({ label: "Bob · 2 Oak", at: "2026-11-04T11:00:03Z" }),
          "invoice-create.no_person|evt2": JSON.stringify({ at: "2026-11-04T11:00:01Z" }),
        },
      },
    ]);
    expect(jobs.map((j) => [j.id, j.reason, j.label])).toEqual([
      ["evt2", "invoice-create.no_accepted_estimate", "Jane · 1 Elm"],
      ["evt1", "invoice-create.no_qb_customer", "Bob · 2 Oak"],
    ]);
  });

  it("is ongoing at 3 distinct jobs, not 2", () => {
    const j = (id: string) => ({ id, label: id, reason: "invoice-create.no_person", day: "2026-11-05", at: "x" });
    expect(JOBS_NOT_INVOICED_ONGOING).toBe(3);
    expect(jobsNotInvoicedOngoing([j("a"), j("b")])).toBe(false);
    expect(jobsNotInvoicedOngoing([j("a"), j("b"), j("c")])).toBe(true);
  });
});

const run = (n: number, conclusion: string | null, hAgo: number, status = "completed"): CiRun => ({
  id: n,
  number: n,
  sha: `sha${n}`,
  title: `commit ${n}`,
  status,
  conclusion,
  createdAt: hoursAgo(hAgo),
  url: `https://github.com/run/${n}`,
});
const ci = (runs: CiRun[]): CiStatus => ({ configured: true, envVar: "GITHUB_TOKEN", runs });

describe("ciVerdict", () => {
  it("green when the last settled run passed", () => {
    expect(ciVerdict(ci([run(3, "success", 1), run(2, "failure", 2)]), NOW)).toMatchObject({ state: "green", redStreak: 0, ongoing: false });
  });

  it("one fresh red run is red but not ongoing", () => {
    expect(ciVerdict(ci([run(3, "failure", 1), run(2, "success", 2)]), NOW)).toMatchObject({ state: "red", redStreak: 1, ongoing: false });
  });

  it("two red runs in a row are ongoing; cancelled runs in between don't break the streak", () => {
    const v = ciVerdict(ci([run(4, "failure", 1), run(3, "cancelled", 1.5), run(2, "failure", 2), run(1, "success", 3)]), NOW);
    expect(v).toMatchObject({ state: "red", redStreak: 2, ongoing: true, redSince: hoursAgo(2) });
  });

  it("one red run left for 24h is ongoing", () => {
    expect(ciVerdict(ci([run(2, "failure", CI_RED_ONGOING_HOURS + 1), run(1, "success", 30)]), NOW).ongoing).toBe(true);
  });

  it("a running build after a red one still reads red; no token or no runs is unknown", () => {
    expect(ciVerdict(ci([run(3, null, 0.1, "in_progress"), run(2, "failure", 1)]), NOW).state).toBe("red");
    expect(ciVerdict(ci([run(3, null, 0.1, "in_progress")]), NOW).state).toBe("running");
    expect(ciVerdict({ configured: false, envVar: "GITHUB_TOKEN", runs: [] }, NOW).state).toBe("unknown");
    expect(ciVerdict(null, NOW).state).toBe("unknown");
  });
});

describe("systemCandidates (float to Today only when ongoing)", () => {
  const job = (id: string, day: string) => ({ id, label: `Customer ${id}`, reason: "invoice-create.no_qb_customer", day, at: `${day}T11:00:00Z` });
  const quietCi = ciVerdict(null, NOW);

  it("nothing for 2 skipped jobs and a single red run", () => {
    const oneRed = ciVerdict(ci([run(2, "failure", 1), run(1, "success", 2)]), NOW);
    expect(systemCandidates({ jobs: [job("a", "2026-11-05"), job("b", "2026-11-04")], ci: oneRed })).toEqual([]);
  });

  it("a red money item for 3+ jobs not invoiced, fingerprinted on the job set", () => {
    const [c] = systemCandidates({ jobs: [job("c", "2026-11-05"), job("a", "2026-11-04"), job("b", "2026-11-02")], ci: quietCi });
    expect(c).toMatchObject({ key: "sys:jobs-not-invoiced", area: "system", severity: "red", sensitive: "money", fingerprint: "a,b,c" });
    expect(c.title).toBe("3 jobs in 7 days were not auto-invoiced");
    expect(c.detail).toContain("Customer c (no QuickBooks customer)");
  });

  it("a yellow item when CI is ongoing red, linked to the failing run", () => {
    const red = ciVerdict(ci([{ ...run(3, "failure", 1), failedStep: "Test" }, run(2, "failure", 2)]), NOW);
    const [c] = systemCandidates({ jobs: [], ci: red });
    expect(c).toMatchObject({ key: "sys:ci-red", severity: "yellow", link: "https://github.com/run/3" });
    expect(c.detail).toContain('failed at "Test"');
  });
});
