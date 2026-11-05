/**
 * Mint a refresh token for the Ads/GA4 OAuth client (aac-astro's desktop
 * client, project astro-website-489317) with adwords + analytics.readonly
 * + datamanager. Writes it to GOOGLE_ADS_REFRESH_TOKEN in .env.diagnostic.
 * Run from the repo root; a browser opens for consent.
 */
import http from 'node:http';
import fs from 'node:fs';
import { exec } from 'node:child_process';
import { google } from 'googleapis';

const PORT = 4568;
const REDIRECT = `http://localhost:${PORT}`;
const SCOPES = [
  'https://www.googleapis.com/auth/adwords',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/datamanager',
];
const client = JSON.parse(
  fs.readFileSync('/Users/matt/Projects/aac-astro/scripts/.credentials/google-oauth.json', 'utf8'),
).installed;
const oauth = new google.auth.OAuth2(client.client_id, client.client_secret, REDIRECT);
const url = oauth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });

const server = http.createServer(async (req, res) => {
  const code = new URL(req.url ?? '/', REDIRECT).searchParams.get('code');
  if (!code) { res.end('no code'); return; }
  const { tokens } = await oauth.getToken(code);
  if (!tokens.refresh_token) { res.end('No refresh token returned.'); process.exit(1); }
  const env = fs.readFileSync('.env.diagnostic', 'utf8')
    .replace(/^GOOGLE_ADS_REFRESH_TOKEN=.*$/m, `GOOGLE_ADS_REFRESH_TOKEN=${tokens.refresh_token}`);
  fs.writeFileSync('.env.diagnostic', env);
  res.end('Done. You can close this tab.');
  console.log('Saved GOOGLE_ADS_REFRESH_TOKEN. Scopes:', tokens.scope);
  server.close();
  process.exit(0);
});
server.listen(PORT, () => {
  console.log('Opening consent page:', url);
  exec(`open "${url}"`);
});
