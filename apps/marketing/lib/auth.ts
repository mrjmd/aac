import { cookies } from "next/headers";

const SESSION_COOKIE = "aac-marketing-session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

async function sign(value: string): Promise<string> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET not set");

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

export async function createSession(): Promise<void> {
  const token = await sign("authenticated");
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE,
    path: "/",
  });
}

export async function verifySession(): Promise<boolean> {
  try {
    const jar = await cookies();
    const token = jar.get(SESSION_COOKIE)?.value;
    if (!token) return false;

    const expected = await sign("authenticated");
    return token === expected;
  } catch {
    return false;
  }
}

export function checkPassword(password: string): boolean {
  const expected = process.env.AUTH_PASSWORD;
  if (!expected) throw new Error("AUTH_PASSWORD not set");
  return password === expected;
}
