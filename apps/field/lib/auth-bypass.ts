/**
 * Preview-mode auth bypass. When FIELD_AUTH_BYPASS_EMAIL is set, the app
 * acts as that user with no sign-in. Never honored in production
 * (VERCEL_ENV === 'production'), so a stray env var on the prod project
 * can't switch field auth off.
 *
 * Edge-safe (no imports): the middleware, session.ts, env.ts and the
 * layout/login pages all read the bypass through this one function.
 */
export function authBypassEmail(): string | undefined {
  if (process.env.VERCEL_ENV === 'production') return undefined;
  return process.env.FIELD_AUTH_BYPASS_EMAIL?.trim().toLowerCase() || undefined;
}
