/**
 * Classify calendar events by type (job, assessment, callback, other)
 * based on their colorId.
 *
 * Google Calendar colorIds:
 *   10 = green     → JOB (paid work)
 *   5  = purple    → ASSESSMENT (site visit, no payment)
 *   anything else  → CALLBACK / OTHER (treat as photo-only completion)
 */

export type EventType = 'job' | 'assessment' | 'other';

export function classifyEvent(colorId: string | undefined): EventType {
  if (colorId === '10') return 'job';
  if (colorId === '5') return 'assessment';
  return 'other';
}

export function labelForType(type: EventType): string {
  switch (type) {
    case 'job': return 'Job';
    case 'assessment': return 'Assessment';
    case 'other': return 'Event';
  }
}

export function badgeColorClasses(type: EventType): string {
  switch (type) {
    case 'job': return 'bg-emerald-100 text-emerald-800 border-emerald-300';
    case 'assessment': return 'bg-purple-100 text-purple-800 border-purple-300';
    case 'other': return 'bg-zinc-100 text-zinc-700 border-zinc-300';
  }
}
