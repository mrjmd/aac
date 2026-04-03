/**
 * Environment variable validation and access.
 *
 * Adapted from aac-slim/src/lib/env.ts.
 * Stripped: qstash (campaign queuing), searchbug (phone validation).
 */

export interface EnvConfig {
  pipedrive: {
    apiKey: string;
    companyDomain: string;
    systemUserId: string;
  };
  quo: {
    apiKey: string;
    webhookSecret: string;
    phoneNumber: string;
  };
  googleAds: {
    webhookKey: string | null;
  };
  gemini: {
    apiKey: string | null;
  };
  quickbooks: {
    clientId: string;
    clientSecret: string;
    realmId: string;
    redirectUri: string;
  };
  google: {
    clientId: string | null;
    clientSecret: string | null;
    refreshToken: string | null;
    calendarId: string;
    technicianEmails: string[];
  };
  notifications: {
    alertPhoneNumber: string;
  };
  cron: {
    secret: string | null;
  };
  redis: {
    url: string;
    token: string;
  };
  nodeEnv: 'development' | 'production';
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

let cachedConfig: EnvConfig | null = null;

export function getEnv(): EnvConfig {
  if (cachedConfig) return cachedConfig;

  cachedConfig = {
    pipedrive: {
      apiKey: requireEnv('PIPEDRIVE_API_KEY'),
      companyDomain: requireEnv('PIPEDRIVE_COMPANY_DOMAIN'),
      systemUserId: requireEnv('PIPEDRIVE_SYSTEM_USER_ID'),
    },
    quo: {
      apiKey: requireEnv('QUO_API_KEY'),
      webhookSecret: requireEnv('QUO_WEBHOOK_SECRET'),
      phoneNumber: requireEnv('QUO_PHONE_NUMBER'),
    },
    googleAds: {
      webhookKey: process.env.GOOGLE_ADS_WEBHOOK_KEY || null,
    },
    gemini: {
      apiKey: process.env.GEMINI_API_KEY || null,
    },
    quickbooks: {
      clientId: requireEnv('QUICKBOOKS_CLIENT_ID'),
      clientSecret: requireEnv('QUICKBOOKS_CLIENT_SECRET'),
      realmId: requireEnv('QUICKBOOKS_REALM_ID'),
      redirectUri: requireEnv('QUICKBOOKS_REDIRECT_URI'),
    },
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || null,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || null,
      refreshToken: process.env.GOOGLE_REFRESH_TOKEN || null,
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'matt@attackacrack.com',
      technicianEmails: (process.env.TECHNICIAN_EMAILS || 'mike@attackacrack.com,harrringtonm@gmail.com')
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean),
    },
    notifications: {
      alertPhoneNumber: requireEnv('ALERT_PHONE_NUMBER'),
    },
    cron: {
      secret: process.env.CRON_SECRET || null,
    },
    redis: {
      url: requireEnv('UPSTASH_REDIS_REST_URL'),
      token: requireEnv('UPSTASH_REDIS_REST_TOKEN'),
    },
    nodeEnv: (process.env.NODE_ENV as 'development' | 'production') || 'development',
  };

  return cachedConfig;
}

export function isProduction(): boolean {
  return getEnv().nodeEnv === 'production';
}
