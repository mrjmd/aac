/**
 * Classify calendar events by type based on their Google Calendar colorId.
 *
 * Matt's color convention (confirmed against the live calendar 2026-05-27):
 *
 *   10 (Basil, green)   → REPAIR     — paid work
 *    3 (Grape, purple)  → ASSESSMENT — sales visit, no payment
 *    5 (Banana, yellow) → CALLBACK   — return visit for a prior repair
 *   anything else       → OTHER      — internal meetings / non-customer
 */

export type EventType = 'repair' | 'assessment' | 'callback' | 'other';

export function classifyEvent(colorId: string | undefined): EventType {
  if (colorId === '10') return 'repair';
  if (colorId === '3') return 'assessment';
  if (colorId === '5') return 'callback';
  return 'other';
}

export function labelForType(type: EventType): string {
  switch (type) {
    case 'repair': return 'Repair';
    case 'assessment': return 'Assessment';
    case 'callback': return 'Callback';
    case 'other': return 'Other';
  }
}

/**
 * Pill colors matched to Google Calendar's actual color names so the badges
 * read at a glance — green = repair, purple = assessment, yellow = callback.
 */
export function badgeColorClasses(type: EventType): string {
  switch (type) {
    case 'repair':     return 'bg-emerald-100 text-emerald-800 border-emerald-300';
    case 'assessment': return 'bg-purple-100  text-purple-800  border-purple-300';
    case 'callback':   return 'bg-amber-100   text-amber-800   border-amber-300';
    case 'other':      return 'bg-zinc-100    text-zinc-700    border-zinc-300';
  }
}
