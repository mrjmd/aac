#!/usr/bin/env npx tsx
/**
 * Close (or otherwise re-status) a QBO estimate so it stops counting as
 * open pipeline. Usage, from repo root:
 *   npx tsx tools/src/commissions/close-estimate.ts <qboEstimateId> [status]
 * status defaults to 'Closed'. Find the internal Id in snapshot.json or QBO.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Redis } from '@upstash/redis';
import { QuickBooksClient, type QBEstimateStatus } from '@aac/api-clients/quickbooks';
import { keys } from '@aac/shared-utils/redis';
import type { QBOAuthTokens } from '@aac/shared-utils/types';
import { loadEnv, requireEnv, DATA_DIR } from './lib';

async function main(): Promise<void> {
  loadEnv();
  const [estimateId, status = 'Closed'] = process.argv.slice(2);
  if (!estimateId) throw new Error('Usage: close-estimate.ts <qboEstimateId> [status]');

  const redis = new Redis({
    url: requireEnv('UPSTASH_REDIS_REST_URL'),
    token: requireEnv('UPSTASH_REDIS_REST_TOKEN'),
  });
  const qb = new QuickBooksClient({
    clientId: requireEnv('QUICKBOOKS_CLIENT_ID'),
    clientSecret: requireEnv('QUICKBOOKS_CLIENT_SECRET'),
    realmId: requireEnv('QUICKBOOKS_REALM_ID'),
    redirectUri: requireEnv('QUICKBOOKS_REDIRECT_URI'),
    getTokens: async () => (await redis.get<QBOAuthTokens>(keys.qbOAuthTokens)) ?? null,
    saveTokens: async (tokens) => {
      await redis.set(keys.qbOAuthTokens, tokens);
      const backupDir = path.join(DATA_DIR, '.token-backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(path.join(backupDir, `${stamp}.json`), JSON.stringify(tokens, null, 2));
    },
  });

  const before = await qb.getEstimate(estimateId);
  if (!before) throw new Error(`Estimate ${estimateId} not found`);
  console.log(`Estimate ${estimateId} (doc ${before.DocNumber ?? '?'}, ${before.CustomerRef?.name ?? '?'}, $${before.TotalAmt}): ${before.TxnStatus} -> ${status}`);

  const after = await qb.updateEstimateStatus(estimateId, status as QBEstimateStatus);
  console.log(`Done — TxnStatus is now ${after.TxnStatus}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
