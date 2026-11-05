/**
 * Create the three UPLOAD_CLICKS conversion actions (secondary). Account
 * change: owner approval required. Validates only unless --apply.
 *
 *   npx tsx tools/src/ads-conversions/setup-actions.ts           # validate
 *   npx tsx tools/src/ads-conversions/setup-actions.ts --apply
 */
import { conversionActionOperations } from '@aac/ads-conversions';
import { googleAdsFromEnv, loadEnv } from '../lib/env.js';

loadEnv();
const apply = process.argv.includes('--apply');
const ads = googleAdsFromEnv();
const ops = conversionActionOperations(await ads.listConversionActions());
console.log(JSON.stringify(ops, null, 2));
if (!ops.length) {
  console.log('All three actions already exist.');
} else {
  const res = await ads.mutate('conversionActions', ops, { validateOnly: !apply });
  console.log(apply ? 'Created:' : 'Validated (nothing created):', JSON.stringify(res));
}
