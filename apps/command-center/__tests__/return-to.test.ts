import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const redisSet = vi.fn();
vi.mock("@/lib/redis", () => ({ getRedis: () => ({ set: redisSet }) }));

const { safeReturnTo } = await import("@/lib/google-signin");
const { GET } = await import("@/app/auth/google/route");

const ORIGIN = "https://hq.attackacrack.com";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CC_GOOGLE_OAUTH_CLIENT_ID = "client";
  process.env.CC_GOOGLE_OAUTH_CLIENT_SECRET = "secret";
});

describe("safeReturnTo", () => {
  it("keeps same-origin paths", () => {
    expect(safeReturnTo("/customers/12?tab=q", ORIGIN)).toBe("/customers/12?tab=q");
  });

  it.each(["//evil.com", "/\\evil.com", "/\t/evil.com", "https://evil.com/", "/x/..//evil.com"])(
    "sends %j home",
    (next) => {
      expect(safeReturnTo(next, ORIGIN)).toBe("/");
    },
  );
});

describe("GET /auth/google", () => {
  async function storedReturnTo(next: string): Promise<string> {
    const res = await GET(new NextRequest(`${ORIGIN}/auth/google?next=${encodeURIComponent(next)}`));
    expect(res.status).toBe(307);
    return redisSet.mock.calls[0][1] as string;
  }

  it("stores a same-origin return-to with the state", async () => {
    expect(await storedReturnTo("/money?x=1")).toBe("/money?x=1");
  });

  it("stores / for a backslash open-redirect attempt", async () => {
    expect(await storedReturnTo("/\\evil.com")).toBe("/");
  });
});
