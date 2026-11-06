/**
 * QuickBooks OAuth Callback Handler
 *
 * Receives the authorization code from QuickBooks and exchanges it for tokens.
 * Stores tokens in Redis for later use by the QuickBooks client.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createLogger } from '@aac/shared-utils/logger';
import { getEnv } from '../../../lib/env.js';
import { qboTokenStore } from '@aac/shared-utils/qbo-tokens';
import { getRedis } from '../../../lib/redis.js';
import { keys } from '@aac/shared-utils/redis';

const log = createLogger('quickbooks-oauth-callback');

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds until access token expires (typically 3600 = 1 hour)
  x_refresh_token_expires_in: number; // seconds until refresh token expires (typically 8726400 = 101 days)
  token_type: string;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const env = getEnv();

  const { code, state, realmId, error, error_description } = req.query;

  res.setHeader('Cache-Control', 'no-store');

  // Check for errors from QuickBooks
  if (error) {
    log.error('OAuth error from QuickBooks', new Error(String(error_description || error)));
    res.status(400).send(`
      <h1>QuickBooks Authorization Failed</h1>
      <p>Error: ${escapeHtml(String(error))}</p>
      <p>${escapeHtml(String(error_description || ''))}</p>
    `);
    return;
  }

  // Validate state (CSRF protection): the one-time nonce /connect stored.
  // DEL is the existence check, so a nonce can't be used twice.
  const stateOk =
    typeof state === 'string' &&
    state.length > 0 &&
    (await getRedis().del(keys.qbOAuthState(state))) === 1;
  if (!stateOk) {
    log.warn('Invalid or expired OAuth state');
    res.status(400).send('<h1>Invalid or expired state. Start again from /api/auth/quickbooks/connect.</h1>');
    return;
  }

  // Validate code
  if (!code || typeof code !== 'string') {
    log.warn('Missing authorization code');
    res.status(400).send('<h1>Missing authorization code</h1>');
    return;
  }

  // Only the configured company: tokens for any other realm would break
  // every QBO call until the next reconnect.
  if (realmId !== env.quickbooks.realmId) {
    log.warn('QuickBooks callback for a different realm; tokens not saved', {
      realmId: typeof realmId === 'string' ? realmId : null,
    });
    res.status(400).send(`
      <h1>Wrong QuickBooks company</h1>
      <p>This company doesn't match QUICKBOOKS_REALM_ID. No tokens were saved.</p>
    `);
    return;
  }

  try {
    // Exchange code for tokens
    const tokenUrl = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

    const credentials = Buffer.from(
      `${env.quickbooks.clientId}:${env.quickbooks.clientSecret}`
    ).toString('base64');

    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: env.quickbooks.redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      log.error('Token exchange failed', new Error(errorText), {
        status: tokenResponse.status,
      });
      res.status(500).send(`
        <h1>Token Exchange Failed</h1>
        <p>Status: ${tokenResponse.status}. Details are in the middleware logs.</p>
      `);
      return;
    }

    const tokens = (await tokenResponse.json()) as TokenResponse;

    // Calculate expiration timestamp
    const now = Date.now();
    const expiresAt = now + tokens.expires_in * 1000;

    // Store tokens in Redis
    // Note: QBOAuthTokens type expects accessToken, refreshToken, expiresAt, realmId.
    // We use the configured realmId rather than the callback's realmId to stay consistent.
    await qboTokenStore(getRedis()).saveTokens({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt,
      realmId: String(realmId || env.quickbooks.realmId),
    });

    log.info('QuickBooks OAuth tokens stored successfully', {
      expiresIn: tokens.expires_in,
      refreshExpiresIn: tokens.x_refresh_token_expires_in,
    });

    res.status(200).send(`
      <h1>QuickBooks Connected Successfully!</h1>
      <p>Access token expires in: ${Math.round(Number(tokens.expires_in) / 60)} minutes</p>
      <p>Refresh token expires in: ${Math.round(Number(tokens.x_refresh_token_expires_in) / 86400)} days</p>
      <p style="color: green;">Realm ID matches QUICKBOOKS_REALM_ID</p>
      <p>You can close this window.</p>
    `);
  } catch (error) {
    log.error('OAuth callback error', error as Error);
    res.status(500).send(`
      <h1>Authorization Error</h1>
      <p>An unexpected error occurred. Please try again.</p>
    `);
  }
}
