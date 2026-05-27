/**
 * Wipes all field:completion:* records so the same job can be re-tested.
 *
 * Invoked by `deploy:fresh`. Reads Redis credentials from process.env (the
 * deploy-fresh shell wrapper pulls them via `vercel env pull` before this
 * script runs).
 *
 * IMPORTANT: this is a development-iteration tool. Don't wire it into the
 * default `deploy` script after Mike starts using the app for real — it
 * would erase his actual completion history.
 */

import { Redis } from '@upstash/redis';
import { keys as keyBuilders } from '@aac/shared-utils/redis';

async function main() {
  const r = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });

  if (!keyBuilders.fieldCompletion('test').startsWith('field:completion:')) {
    throw new Error('Unexpected fieldCompletion key shape — refusing to wipe.');
  }

  const found = await r.keys('field:completion:*');
  if (found.length === 0) {
    console.log('  no field:completion:* records to delete');
    return;
  }
  await r.del(...found);
  console.log(`  deleted ${found.length} field:completion:* record(s)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
