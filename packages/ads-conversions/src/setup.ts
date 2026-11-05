/**
 * One-time: create the three UPLOAD_CLICKS conversion actions as SECONDARY
 * (primaryForGoal false), so they're reported but bidding doesn't change
 * until the owner flips the goal. Idempotent: existing names are skipped.
 * Account changes need owner approval; run with validateOnly first.
 */
import type { ConversionActionRow } from '@aac/api-clients/google-ads';
import { ACTION_NAMES } from './run.js';
import type { Stage } from './stages.js';

const CATEGORY: Record<Stage, string> = {
  lead: 'QUALIFIED_LEAD',
  quote: 'REQUEST_QUOTE',
  won: 'CONVERTED_LEAD',
};

export function conversionActionOperations(existing: ConversionActionRow[]): Record<string, unknown>[] {
  const have = new Set(existing.map((a) => a.name));
  return (Object.keys(ACTION_NAMES) as Stage[])
    .filter((stage) => !have.has(ACTION_NAMES[stage]))
    .map((stage) => ({
      create: {
        name: ACTION_NAMES[stage],
        type: 'UPLOAD_CLICKS',
        category: CATEGORY[stage],
        status: 'ENABLED',
        primaryForGoal: false,
        countingType: 'ONE_PER_CLICK',
        clickThroughLookbackWindowDays: 90,
        valueSettings: { defaultValue: 0, defaultCurrencyCode: 'USD', alwaysUseDefaultValue: false },
      },
    }));
}
