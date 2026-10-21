/**
 * The deliverable: a 🤖 draft note on the customer's Quo contact for
 * copy/paste send. No prefill deep link — the URL-encoded body dwarfed
 * the note and Matt never used it (removed on his request, 2026-10-20).
 */
import type { DraftDeps } from './types.js';

export async function postDraftNote(
  deps: DraftDeps,
  phone: string,
  kind: string,
  body: string,
  extra: string,
): Promise<boolean> {
  const noteText = `🤖 ${kind} DRAFT — copy/paste to send (bot never sends):\n\n${body}\n\n———\n${extra}`;
  if (deps.dryRun) {
    console.log(`\n[dry-run] note for ${phone}:\n${noteText}\n`);
    return true;
  }
  const contact = await deps.quo.findContactByPhone(phone);
  if (!contact) return false;
  await deps.quo.createContactNote(contact.id, noteText);
  return true;
}
