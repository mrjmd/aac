/**
 * Quote drafter core — bot-marked Pending estimates in QBO. Ported from
 * tools/src/drafter/run.ts (v1, live 2026-10-18) with two 10/21 fixes:
 *
 *  1. Customer resolution is PHONE-FIRST against live QBO (the stale
 *     triage snapshot + name-only search minted duplicate customers —
 *     John Skinner, 2026-10-20).
 *  2. A bot-owned pending draft is only regenerated when there is new
 *     INBOUND content — Matt's own outbound texts are not "new info".
 *
 * CREATE-ONCE-ONLY: idempotency skips any customer with a bot draft
 * already pending unless bot-owned regeneration applies, and a foreign
 * SyncToken bump = HUMAN-OWNED forever. Nothing is ever sent.
 */
import type { QBEstimate, QuickBooksClient } from '@aac/api-clients/quickbooks';
import type { QuoClient } from '@aac/api-clients/quo';
import {
  assembleEstimateLines,
  buildAreaAnalysisPrompt,
  buildDescriptionLibrary,
  buildDraftPrivateNote,
  buildQuoteDraftPrompt,
  areaSituationText,
  draftTotal,
  formatPhotoContext,
  isBotDraft,
  parseAreaAnalysis,
  parseQuoteDraftResponse,
  retrieveSimilar,
  selectComparables,
  validateQuoteDraft,
  diffDraftLines,
  buildDraftCreatedNote,
  buildDraftUpdatedNote,
  type DraftThreadMessage,
} from '@aac/quoting';
import { keys } from '@aac/shared-utils/redis';
import { generateWithRetry } from './gemini.js';
import { fetchFieldContext, type FieldChannel } from './field-context.js';
import {
  EXEMPLARS_PER_AREA,
  MAX_PHOTOS,
  MAX_THREAD_MESSAGES,
  type DrafterAssets,
  type DrafterDeps,
  type DraftRunRecord,
  type QuoteFinding,
} from './types.js';

/** Per-run shared context: one QBO fetch feeds every draft in the run. */
export interface RunContext {
  items: Awaited<ReturnType<QuickBooksClient['listItems']>>;
  itemNames: string[];
  recentEstimates: QBEstimate[];
  library: Map<string, string>;
  today: string;
  nextDocNumber: number;
}

export async function prepareRun(deps: DrafterDeps): Promise<RunContext> {
  const items = await deps.qb.listItems();
  const yearAgo = new Date(deps.now() - 365 * 86_400_000).toISOString().slice(0, 10);
  const recentEstimates = await deps.qb.listRecentEstimates(yearAgo);
  const library = buildDescriptionLibrary(recentEstimates);
  deps.log(
    `QBO: ${items.length} items, ${recentEstimates.length} recent estimates, ${library.size} canonical descriptions`,
  );
  // AAC's QBO uses custom transaction numbers — the API assigns nothing,
  // so continue the estimate sequence ourselves (invoices number separately).
  const nextDocNumber =
    Math.max(
      0,
      ...recentEstimates.map((e) => Number(e.DocNumber)).filter((n) => Number.isFinite(n) && n > 0),
    ) + 1;
  return {
    items,
    itemNames: items.map((i) => i.Name),
    recentEstimates,
    library,
    today: new Date(deps.now()).toISOString().slice(0, 10),
    nextDocNumber,
  };
}

/**
 * Post a conversation-panel note on the customer's Quo contact announcing
 * the draft (owner request 2026-10-18). Fire-safe: note failures never
 * affect the draft outcome.
 */
async function postDraftNote(
  quo: QuoClient,
  log: (l: string) => void,
  phone: string,
  text: string,
): Promise<void> {
  try {
    const contact = await quo.findContactByPhone(phone);
    if (!contact) {
      log('  ~ no Quo contact for note — skipped');
      return;
    }
    await quo.createContactNote(contact.id, text);
    log('  ✓ posted Quo note');
  } catch (err) {
    log(`  ⚠ Quo note failed (${(err as Error).message.slice(0, 80)}) — draft unaffected`);
  }
}

export interface DraftOneOptions {
  finding: QuoteFinding;
  run: RunContext;
  assets: DrafterAssets;
  fieldChannel: FieldChannel | null;
  dryRun: boolean;
  /**
   * Trigger-runner guard: skip customers with ANY estimate newer than N
   * days (bot or human) — automated runs must not stack next to a quote
   * that already exists. Manual runs omit it and keep full control.
   */
  skipIfRecentEstimateDays?: number;
  /**
   * Whether the triggering evidence contains new INBOUND content. When
   * false (e.g. T3 fired on Matt's own outbound text), an existing
   * bot-owned draft is left alone instead of regenerated — there is no
   * new customer information to regenerate FROM. Manual runs pass true.
   */
  hasNewInbound: boolean;
  /** Photos that arrived outside Quo (email, AirDrop) — manual runs only. */
  extraImageParts?: Array<{ mimeType: string; base64: string }>;
  /** Group threads: pass the FULL participant set (manual runs only). */
  threadParticipants?: string[];
}

export async function draftOne(deps: DrafterDeps, opts: DraftOneOptions): Promise<DraftRunRecord> {
  const { qb, quo, gemini, redis, log } = deps;
  const { finding, run, assets } = opts;
  const phone = finding.phone;
  const customerName = finding.customer?.trim() || phone;

  // ── resolve the QBO customer: live phone match first (10/21 fix), then
  //    name chain (finding → Quo contact → QBO name search → create).
  let customerId: string | null = null;
  let resolvedName = customerName;
  let liveName = finding.customer?.trim() || null;
  const byPhone = await qb.findCustomerByPhone(phone);
  if (byPhone?.Id) {
    customerId = byPhone.Id;
    resolvedName = byPhone.DisplayName ?? resolvedName;
    log(`  resolved by phone → QBO customer ${customerId} "${resolvedName}"`);
  }
  if (!customerId && !liveName) {
    // Middleware syncs the AI-extracted name onto the Quo contact within
    // minutes of first touch — that's the freshest name source we have.
    const contact = await quo.findContactByExternalId(phone);
    const quoName = [contact?.defaultFields.firstName, contact?.defaultFields.lastName]
      .filter(Boolean)
      .join(' ')
      .trim();
    if (quoName && !/^[+\d\s().-]+$/.test(quoName)) liveName = quoName;
  }
  if (!customerId && liveName) {
    const byName = await qb.searchCustomerByName(liveName);
    if (byName?.Id) {
      customerId = byName.Id;
      resolvedName = byName.DisplayName ?? liveName;
    } else {
      resolvedName = liveName;
    }
  }

  // ── ownership & idempotency (SyncToken one-way door, owner 2026-10-18)
  let updateTarget: QBEstimate | null = null;
  if (customerId) {
    const existing = await qb.getEstimatesByCustomer(customerId);
    const botPending = existing.find((e) => e.TxnStatus === 'Pending' && isBotDraft(e));
    if (botPending) {
      const stored = await redis.get(keys.quoteDraftSyncToken(botPending.Id));
      const botOwned =
        stored !== null && stored !== undefined && String(stored) === String(botPending.SyncToken);
      if (botOwned) {
        if (!opts.hasNewInbound) {
          const msg = `bot draft #${botPending.DocNumber} already pending and no new inbound content — nothing to regenerate from`;
          log(`  ~ skipped: ${msg}`);
          return { phone, customer: resolvedName, outcome: 'skipped', detail: msg };
        }
        updateTarget = botPending;
        log(`  ~ bot-owned draft #${botPending.DocNumber} — will regenerate in place`);
      } else {
        const msg = `bot draft #${botPending.DocNumber} is human-owned (owner edited, or pre-ownership era) — never touching it`;
        if (!opts.dryRun) {
          log(`  ~ skipped: ${msg}`);
          return { phone, customer: resolvedName, outcome: 'skipped', detail: msg };
        }
        log(`  ~ note: ${msg} — a live run would skip; continuing (dry-run)`);
      }
    } else if (opts.skipIfRecentEstimateDays) {
      const cutoff = new Date(deps.now() - opts.skipIfRecentEstimateDays * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const recent = existing.find((e) => (e.TxnDate ?? '') >= cutoff);
      if (recent) {
        log(
          `  ~ skipped: estimate #${recent.DocNumber} (${recent.TxnDate}) within ${opts.skipIfRecentEstimateDays}d — not stacking`,
        );
        return {
          phone,
          customer: resolvedName,
          outcome: 'skipped',
          detail: `recent estimate #${recent.DocNumber} (${recent.TxnDate})`,
        };
      }
    }
  }

  // ── assemble the thread + photos fresh from Quo
  const page = await quo.listMessages({
    participantE164: opts.threadParticipants ?? phone,
    maxResults: MAX_THREAD_MESSAGES,
  });
  const messages = [...page.data].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  if (messages.length === 0) {
    log('  ~ skipped: no Quo messages for this number');
    return { phone, customer: resolvedName, outcome: 'skipped', detail: 'no Quo messages' };
  }
  const thread: DraftThreadMessage[] = messages.map((m) => ({
    direction: m.direction === 'outgoing' ? 'outgoing' : 'incoming',
    at: m.createdAt,
    text: m.text || (m.media?.length ? '[photo]' : ''),
  }));

  const imageParts: Array<{ mimeType: string; base64: string }> = [];
  for (const m of messages) {
    if (m.direction !== 'incoming' || !m.media) continue;
    for (const media of m.media) {
      if (imageParts.length >= MAX_PHOTOS) break;
      if (media.type && !media.type.startsWith('image/')) continue;
      const dl = await quo.downloadMessageMedia(media.url).catch(() => null);
      if (!dl || !dl.contentType.startsWith('image/')) continue;
      imageParts.push({ mimeType: dl.contentType, base64: Buffer.from(dl.data).toString('base64') });
    }
  }
  for (const part of opts.extraImageParts ?? []) {
    if (imageParts.length >= MAX_PHOTOS) break;
    imageParts.push(part);
  }
  log(`  thread: ${thread.length} messages, ${imageParts.length} photo(s)`);

  // ── photo pre-pass: segment areas, retrieve similar historical areas
  // (degrades to v1 behavior on any failure — never blocks the draft)
  let photoContext: string | undefined;
  if (imageParts.length > 0 && assets.exemplarLibrary.length > 0) {
    try {
      const areaRaw = await generateWithRetry(
        gemini,
        buildAreaAnalysisPrompt({ thread, photoCount: imageParts.length, itemNames: run.itemNames }),
        { imageParts },
      );
      const analysis = parseAreaAnalysis(areaRaw);
      if (analysis) {
        const situations = analysis.areas.map((a) => areaSituationText(a, analysis.photoReads));
        const vectors = await gemini.embedContent(situations, { timeoutMs: 60_000 });
        const retrieved = analysis.areas.map((area, i) => ({
          area,
          exemplars: retrieveSimilar(vectors[i], assets.exemplarLibrary, EXEMPLARS_PER_AREA),
        }));
        photoContext = formatPhotoContext({ analysis, retrieved });
        log(`  areas: ${analysis.areas.length}`);
        for (const { area, exemplars } of retrieved) {
          log(`    [${area.area}] ${area.description.slice(0, 90)}`);
          for (const { item, score } of exemplars.slice(0, 1)) {
            const what = item.quotedItems.length
              ? item.quotedItems.map((q) => q.item).join(' + ')
              : 'NOT QUOTED';
            log(`        ≈ #${item.docNumber} (${score.toFixed(2)}): ${what}`);
          }
        }
      } else {
        log('  ⚠ photo pre-pass unparseable — drafting without area analysis');
      }
    } catch (err) {
      log(`  ⚠ photo pre-pass failed (${(err as Error).message.slice(0, 100)}) — drafting without it`);
    }
  }

  // ── runtime field context: the assessment chain, fetched live
  let techParts: Array<{ mimeType: string; base64: string }> = [];
  if (opts.fieldChannel) {
    try {
      const field = await fetchFieldContext({
        channel: opts.fieldChannel,
        quo,
        gemini,
        customerName: resolvedName,
        customerPhotoCount: imageParts.length,
      });
      if (field.fieldBlock) {
        photoContext = `${photoContext ?? ''}${field.fieldBlock}`;
        techParts = field.techParts;
        log(`  field context: ${field.eventCount} matched event(s), ${techParts.length} technician photo(s)`);
      }
    } catch (err) {
      log(`  ⚠ field context failed (${(err as Error).message.slice(0, 100)}) — drafting without it`);
    }
  }

  // ── draft with Gemini
  const { systemPrompt, userPrompt } = buildQuoteDraftPrompt({
    customerName: resolvedName,
    phone,
    today: run.today,
    rulesetText: assets.rulesetText,
    itemNames: run.itemNames,
    thread,
    photoCount: imageParts.length,
    photoContext,
    visualRulesetText: assets.sectionVText,
  });

  const raw = await generateWithRetry(gemini, userPrompt, {
    systemPrompt,
    imageParts: [...imageParts, ...techParts],
  });

  const parsed = parseQuoteDraftResponse(raw);
  if (!parsed) {
    throw new Error(`unparseable draft response: ${raw.slice(0, 200).replace(/\n/g, ' ')}`);
  }
  const validation = validateQuoteDraft(parsed, run.itemNames);
  if (!validation.ok) {
    log(`  ✗ validation failed: ${validation.errors.join('; ')}`);
    return { phone, customer: resolvedName, outcome: 'failed', detail: validation.errors.join('; ') };
  }
  const draft = validation.draft;

  const comparables = selectComparables(run.recentEstimates, draft);
  const privateNote = buildDraftPrivateNote({
    draft,
    warnings: validation.warnings,
    comparables,
    generatedAt: run.today,
  });
  const lines = assembleEstimateLines({ draft, items: run.items, descriptionLibrary: run.library });

  log(`  draft: $${draftTotal(draft)} (${draft.confidence}${draft.needsSiteVisit ? ', site visit' : ''})`);
  for (const l of draft.lines) {
    log(`    ${l.item}${l.scopeNote ? ` [${l.scopeNote}]` : ''} ×${l.qty} @ $${l.unitPrice}`);
  }
  for (const a of draft.scopeAccounting) {
    log(
      a.quotedItem
        ? `    ✓ "${a.request}" → ${a.quotedItem}`
        : `    ✗ "${a.request}" EXCLUDED: ${a.reason ?? '(no reason)'}`,
    );
  }
  for (const w of validation.warnings) log(`    ⚠ ${w}`);
  for (const q of draft.openQuestions) log(`    ? ${q}`);

  if (opts.dryRun) {
    log(
      `  [dry-run] would ${updateTarget ? `regenerate #${updateTarget.DocNumber} in place` : 'create Pending estimate'}; PrivateNote:`,
    );
    log(privateNote.split('\n').map((l) => `    | ${l}`).join('\n'));
    return {
      phone,
      customer: resolvedName,
      outcome: 'dry-run',
      detail: `$${draftTotal(draft)}`,
      total: draftTotal(draft),
      lines: draft.lines.map((l) => ({ item: l.item, qty: l.qty, unitPrice: l.unitPrice })),
    };
  }

  if (updateTarget) {
    // Regenerate in place. Compare-and-swap on the SyncToken we verified
    // ownership against — if the owner touched the draft between the check
    // and this write, QBO rejects it and the draft becomes human-owned.
    try {
      const revised = await qb.replaceEstimateLines({
        estimateId: updateTarget.Id,
        syncToken: updateTarget.SyncToken,
        customerId: customerId!,
        lines,
        privateNote: `REV ${run.today} — regenerated on new info (was $${updateTarget.TotalAmt}).\n${privateNote}`,
        docNumber: updateTarget.DocNumber,
      });
      await redis.set(keys.quoteDraftSyncToken(revised.Id), String(revised.SyncToken));
      log(`  ✓ regenerated Pending estimate #${revised.DocNumber} — $${revised.TotalAmt} (was $${updateTarget.TotalAmt})`);
      await postDraftNote(quo, log, phone, buildDraftUpdatedNote({
        docNumber: revised.DocNumber ?? String(run.nextDocNumber),
        estimateId: revised.Id,
        total: revised.TotalAmt ?? draftTotal(draft),
        previousTotal: updateTarget.TotalAmt ?? 0,
        changes: diffDraftLines(updateTarget, draft.lines),
      }));
      return {
        phone,
        customer: resolvedName,
        outcome: 'updated',
        detail: `#${revised.DocNumber} regenerated`,
        estimateId: revised.Id,
        docNumber: revised.DocNumber,
        total: revised.TotalAmt,
        lines: draft.lines.map((l) => ({ item: l.item, qty: l.qty, unitPrice: l.unitPrice })),
      };
    } catch (err) {
      const msg = (err as Error).message;
      if (/stale|5010/i.test(msg)) {
        log(`  ~ skipped: owner edited #${updateTarget.DocNumber} mid-flight — now human-owned, not touching`);
        return {
          phone,
          customer: resolvedName,
          outcome: 'skipped',
          detail: `#${updateTarget.DocNumber} edited concurrently — human-owned`,
        };
      }
      throw err;
    }
  }

  if (!customerId) {
    if (!liveName) {
      // No real name anywhere yet. Creating here would mint a customer named
      // after the phone number while middleware creates the real record the
      // moment the name extracts — a guaranteed duplicate. Defer; the next
      // trigger re-runs with the name available.
      log('  ~ deferred: no customer name yet — not creating a phone-named QBO customer');
      return { phone, customer: resolvedName, outcome: 'skipped', detail: 'no name yet — deferred create' };
    }
    try {
      const created = await qb.createCustomer({ displayName: liveName, phone });
      customerId = created.Id!;
      log(`  + created QBO customer ${customerId} "${liveName}"`);
    } catch (err) {
      // 6240 Duplicate Name: QBO's uniqueness check also spans inactive
      // customers and loose casing, which the exact DisplayName query above
      // can miss — attach to the existing record instead of dying.
      if (!/6240|Duplicate Name/i.test((err as Error).message)) throw err;
      const existing = await qb.searchCustomerByName(liveName, { includeInactive: true });
      if (!existing?.Id) throw err;
      customerId = existing.Id;
      resolvedName = existing.DisplayName ?? liveName;
      log(`  ~ duplicate-name resolved to existing QBO customer ${customerId} "${resolvedName}"`);
    }
  }

  const estimate = await qb.createEstimate({
    customerId,
    lines,
    privateNote,
    docNumber: String(run.nextDocNumber),
  });
  await redis.set(keys.quoteDraftSyncToken(estimate.Id), String(estimate.SyncToken));
  log(`  ✓ created Pending estimate #${estimate.DocNumber} — $${estimate.TotalAmt}`);
  await postDraftNote(quo, log, phone, buildDraftCreatedNote({
    docNumber: estimate.DocNumber ?? String(run.nextDocNumber),
    estimateId: estimate.Id,
    total: estimate.TotalAmt ?? draftTotal(draft),
    confidence: draft.confidence,
    needsSiteVisit: draft.needsSiteVisit,
    lines: draft.lines,
  }));
  return {
    phone,
    customer: resolvedName,
    outcome: 'created',
    detail: `#${estimate.DocNumber}`,
    estimateId: estimate.Id,
    docNumber: estimate.DocNumber,
    total: estimate.TotalAmt,
    lines: draft.lines.map((l) => ({ item: l.item, qty: l.qty, unitPrice: l.unitPrice })),
  };
}
