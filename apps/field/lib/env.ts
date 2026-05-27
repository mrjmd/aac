/**
 * Environment variable access for apps/field.
 *
 * Slim version of middleware's env.ts — only includes what field needs.
 * Grow as new integrations (Resend auth, Blob, etc.) are added.
 */

export interface EnvConfig {
  google: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    calendarId: string;
  };
  /**
   * Separate OAuth client for the field-app sign-in flow.
   * Lives alongside the shared `google.*` credentials because the existing
   * monorepo OAuth client is a Desktop-type credential (no web redirect URIs
   * allowed). The field app needs a Web-application client.
   *
   * May be empty strings when {@link auth.bypassEmail} is set — in that case
   * the OAuth flow is never reached, so unconfigured credentials are OK.
   */
  fieldOAuth: {
    clientId: string;
    clientSecret: string;
  };
  auth: {
    /**
     * If set, auth is bypassed and every request is treated as the given
     * email. Used for previewing the UI before OAuth is fully wired in
     * Google Cloud Console. Remove the env var to re-enable real auth.
     */
    bypassEmail?: string;
  };
  pipedrive: {
    apiKey: string;
    companyDomain: string;
  };
  quickbooks: {
    clientId: string;
    clientSecret: string;
    realmId: string;
  };
  redis: {
    url: string;
    token: string;
  };
  notifications: {
    alertPhoneNumber: string;
  };
  /** Emails authorized to log into the field app */
  authWhitelist: string[];
  /** The technician(s) whose calendar events are displayed. */
  technicianEmails: string[];
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

let cached: EnvConfig | null = null;

export function getEnv(): EnvConfig {
  if (cached) return cached;

  const bypassEmail = process.env.FIELD_AUTH_BYPASS_EMAIL?.trim().toLowerCase() || undefined;

  cached = {
    google: {
      clientId: requireEnv('GOOGLE_CLIENT_ID'),
      clientSecret: requireEnv('GOOGLE_CLIENT_SECRET'),
      refreshToken: requireEnv('GOOGLE_REFRESH_TOKEN'),
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'matt@attackacrack.com',
    },
    // OAuth credentials are only required when auth isn't bypassed; in bypass
    // mode we never run the OAuth flow so missing values are tolerated.
    fieldOAuth: bypassEmail
      ? {
          clientId: process.env.FIELD_GOOGLE_OAUTH_CLIENT_ID || '',
          clientSecret: process.env.FIELD_GOOGLE_OAUTH_CLIENT_SECRET || '',
        }
      : {
          clientId: requireEnv('FIELD_GOOGLE_OAUTH_CLIENT_ID'),
          clientSecret: requireEnv('FIELD_GOOGLE_OAUTH_CLIENT_SECRET'),
        },
    auth: { bypassEmail },
    pipedrive: {
      apiKey: requireEnv('PIPEDRIVE_API_KEY'),
      companyDomain: requireEnv('PIPEDRIVE_COMPANY_DOMAIN'),
    },
    quickbooks: {
      clientId: requireEnv('QUICKBOOKS_CLIENT_ID'),
      clientSecret: requireEnv('QUICKBOOKS_CLIENT_SECRET'),
      realmId: requireEnv('QUICKBOOKS_REALM_ID'),
    },
    redis: {
      url: requireEnv('UPSTASH_REDIS_REST_URL'),
      token: requireEnv('UPSTASH_REDIS_REST_TOKEN'),
    },
    notifications: {
      alertPhoneNumber: requireEnv('ALERT_PHONE_NUMBER'),
    },
    authWhitelist: (process.env.AUTH_WHITELIST_EMAILS || 'mike@attackacrack.com,matt@attackacrack.com')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
    technicianEmails: (process.env.TECHNICIAN_EMAILS || 'mike@attackacrack.com,harrringtonm@gmail.com')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  };

  return cached;
}
