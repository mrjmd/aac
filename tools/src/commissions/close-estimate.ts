#!/usr/bin/env npx tsx
/**
 * Close (or otherwise re-status) a QBO estimate so it stops counting as
 * open pipeline. Usage, from repo root:
 *   npx tsx tools/src/commissions/close-estimate.ts <qboEstimateId> [status]
 * status defaults to 'Closed'. Find the internal Id in snapshot.json or QBO.
 */
import { type QBEstimateStatus } from '@aac/api-clients/quickbooks';
import { loadEnv } from './lib';
import { quickBooksFromEnv, redisFromEnv } from '../lib/env';

async function main(): Promise<void> {
  loadEnv();
  const [estimateId, status = 'Closed'] = process.argv.slice(2);
  if (!estimateId) throw new Error('Usage: close-estimate.ts <qboEstimateId> [status]');

  const redis = redisFromEnv();
  const qb = quickBooksFromEnv(redis);

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
