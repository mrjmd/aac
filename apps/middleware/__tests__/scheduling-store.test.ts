/**
 * The middleware's wiring into @aac/scheduling: the store is exactly the
 * Redis helpers, the Quo dispatch passes it, and maybePostSuggestionNote
 * keeps its flag gate and fail-soft contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const redisMocks = vi.hoisted(() => ({
  logHealthError: vi.fn().mockResolvedValue(undefined),
  countCondition: vi.fn().mockResolvedValue(undefined),
  writePendingDirective: vi.fn(),
  getPendingDirective: vi.fn(),
  getDirectiveIdByEstimate: vi.fn(),
  getQbCustomerIdFromPipedrive: vi.fn(),
  storePipedriveToQbMapping: vi.fn(),
  trackSchedulingClassification: vi.fn(),
  markCronAction: vi.fn(),
  readFieldCompletion: vi.fn(),
  getRedis: vi.fn(() => ({ tag: 'redis' })),
}));
vi.mock('../lib/redis.js', () => redisMocks);

const envState = vi.hoisted(() => ({ suggestNotesEnabled: true }));
vi.mock('../lib/env.js', () => ({
  getEnv: vi.fn(() => ({
    google: { technicianEmails: ['mike@attackacrack.com'] },
    scheduling: {
      suggestNotesEnabled: envState.suggestNotesEnabled,
      stubEventsEnabled: true,
      holdEventsEnabled: false,
      stubAttendeeEmails: ['mike@attackacrack.com'],
    },
  })),
}));

const clients = vi.hoisted(() => ({
  pd: { tag: 'pd' },
  qb: { tag: 'qb' },
  quo: { tag: 'quo' },
  cal: { tag: 'cal' },
  maps: { tag: 'maps' },
  gemini: { tag: 'gemini' },
  drive: { tag: 'drive' },
  gmail: { tag: 'gmail' },
}));
vi.mock('../lib/clients.js', () => ({
  getPipedrive: vi.fn(() => clients.pd),
  getQuickBooks: vi.fn(() => clients.qb),
  getQuo: vi.fn(() => clients.quo),
  getCalendar: vi.fn(() => clients.cal),
  getMaps: vi.fn(() => clients.maps),
  getGemini: vi.fn(() => clients.gemini),
  getDrive: vi.fn(() => clients.drive),
  getGmail: vi.fn(() => clients.gmail),
}));

const postNoteMock = vi.hoisted(() => vi.fn());
const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock('@aac/scheduling', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aac/scheduling')>()),
  postSuggestionNoteForDirective: postNoteMock,
  dispatchSchedulingIntent: dispatchMock,
}));

const deferred = vi.hoisted(() => ({ work: [] as Promise<unknown>[] }));
vi.mock('../lib/defer.js', () => ({ defer: (p: Promise<unknown>) => deferred.work.push(p) }));

import type { SchedulingDirective } from '@aac/scheduling';
import type { PipedriveClient } from '@aac/api-clients/pipedrive';
import { schedulingStore } from '../lib/scheduling-store.js';
import { maybePostSuggestionNote } from '../lib/suggestion-note.js';
import { deferSchedulingDispatch } from '../lib/quo-webhook/scheduling.js';
import { getEnv } from '../lib/env.js';
import type { QuoEvent } from '../lib/quo-webhook/types.js';

const directive = { id: 'dir_1' } as unknown as SchedulingDirective;

beforeEach(() => {
  vi.clearAllMocks();
  envState.suggestNotesEnabled = true;
  deferred.work = [];
});

describe('schedulingStore', () => {
  it('countCondition delegates to the middleware Redis helper', async () => {
    await schedulingStore.countCondition?.('dispatch.stub_skipped');
    expect(redisMocks.countCondition).toHaveBeenCalledWith('dispatch.stub_skipped');
  });

  it('forwards every method to its lib/redis.ts helper with the same arguments', async () => {
    const d = { id: 'dir_1' } as unknown as SchedulingDirective;
    redisMocks.getPendingDirective.mockResolvedValueOnce(d);
    redisMocks.markCronAction.mockResolvedValueOnce(true);
    redisMocks.getDirectiveIdByEstimate.mockResolvedValueOnce('dir_9');
    redisMocks.getQbCustomerIdFromPipedrive.mockResolvedValueOnce('qb-1');

    await schedulingStore.logHealthError('src', 'msg', { a: 1 });
    await schedulingStore.writePendingDirective(d);
    await expect(schedulingStore.getPendingDirective('dir_1')).resolves.toBe(d);
    await expect(schedulingStore.getDirectiveIdByEstimate('est-1')).resolves.toBe('dir_9');
    await expect(schedulingStore.getQbCustomerIdFromPipedrive('77')).resolves.toBe('qb-1');
    await schedulingStore.storePipedriveToQbMapping('77', 'qb-1');
    await schedulingStore.trackSchedulingClassification('message.received', { classified: 1, directivesWritten: 0 });
    await expect(schedulingStore.markCronAction('suggestion-note', 'est-1', 60)).resolves.toBe(true);

    expect(redisMocks.logHealthError).toHaveBeenCalledWith('src', 'msg', { a: 1 });
    expect(redisMocks.writePendingDirective).toHaveBeenCalledWith(d);
    expect(redisMocks.getPendingDirective).toHaveBeenCalledWith('dir_1');
    expect(redisMocks.getDirectiveIdByEstimate).toHaveBeenCalledWith('est-1');
    expect(redisMocks.getQbCustomerIdFromPipedrive).toHaveBeenCalledWith('77');
    expect(redisMocks.storePipedriveToQbMapping).toHaveBeenCalledWith('77', 'qb-1');
    expect(redisMocks.trackSchedulingClassification).toHaveBeenCalledWith('message.received', {
      classified: 1,
      directivesWritten: 0,
    });
    expect(redisMocks.markCronAction).toHaveBeenCalledWith('suggestion-note', 'est-1', 60);
  });

  it("leaves markCronAction's TTL default to the helper when omitted", async () => {
    await schedulingStore.markCronAction('x', 'y');
    expect(redisMocks.markCronAction).toHaveBeenCalledWith('x', 'y', undefined);
  });
});

describe('maybePostSuggestionNote', () => {
  it('returns null without running the flow when SCHEDULING_SUGGEST_NOTES is off', async () => {
    envState.suggestNotesEnabled = false;
    await expect(maybePostSuggestionNote(directive, 'qb-webhook')).resolves.toBeNull();
    expect(postNoteMock).not.toHaveBeenCalled();
  });

  it('runs the package flow with the store, clients and technician emails', async () => {
    postNoteMock.mockResolvedValueOnce({ status: 'skipped', reason: 'low_confidence' });
    await expect(maybePostSuggestionNote(directive, 'qb-webhook')).resolves.toEqual({
      status: 'skipped',
      reason: 'low_confidence',
    });
    expect(postNoteMock).toHaveBeenCalledWith(
      {
        store: schedulingStore,
        pd: clients.pd,
        qb: clients.qb,
        quo: clients.quo,
        calendar: clients.cal,
        maps: clients.maps,
        redis: { tag: 'redis' },
        technicianEmails: ['mike@attackacrack.com'],
      },
      directive,
    );
  });

  it('swallows a failure into a health error and returns null', async () => {
    postNoteMock.mockRejectedValueOnce(new Error('quo 500'));
    await expect(maybePostSuggestionNote(directive, 'qb-reconcile')).resolves.toBeNull();
    expect(redisMocks.logHealthError).toHaveBeenCalledWith(
      'suggestion-note',
      'qb-reconcile: quo 500',
      { directiveId: 'dir_1' },
    );
  });
});

describe('deferSchedulingDispatch', () => {
  const event: QuoEvent = {
    id: 'evt-1',
    type: 'message.received',
    createdAt: '2026-10-21T15:00:00Z',
    apiVersion: 'v3',
    data: {
      object: {
        id: 'msg-1',
        object: 'message',
        createdAt: '2026-10-21T15:00:00Z',
        body: 'Lets do it, book me in',
      },
    },
  };

  it('dispatches with the store and the env-driven stub/hold config', async () => {
    dispatchMock.mockResolvedValueOnce({ classified: 1 });
    const pd = clients.pd as unknown as PipedriveClient;
    deferSchedulingDispatch(pd, getEnv(), event, event.data.object, '+16175550123', 7);
    await Promise.all(deferred.work);
    expect(dispatchMock).toHaveBeenCalledWith(
      {
        store: schedulingStore,
        pd,
        cal: clients.cal,
        gemini: clients.gemini,
        quo: clients.quo,
        qb: clients.qb,
        stub: {
          enabled: true,
          technicianEmails: ['mike@attackacrack.com'],
          drive: clients.drive,
          gmail: clients.gmail,
          fetchFieldCompletion: redisMocks.readFieldCompletion,
        },
        holds: { enabled: false },
        postSuggestionNote: maybePostSuggestionNote,
      },
      {
        eventId: 'evt-1',
        eventType: 'message.received',
        text: 'Lets do it, book me in',
        customerPhone: '+16175550123',
        pdPersonId: 7,
      },
    );
  });

  it('defers nothing for event types without classifiable content', () => {
    const call: QuoEvent = { ...event, type: 'call.completed' };
    deferSchedulingDispatch(clients.pd as unknown as PipedriveClient, getEnv(), call, call.data.object, '+1', 7);
    expect(deferred.work).toHaveLength(0);
  });

  it('a throwing dispatch is surfaced to health, not thrown', async () => {
    dispatchMock.mockRejectedValueOnce(new Error('gemini down'));
    deferSchedulingDispatch(clients.pd as unknown as PipedriveClient, getEnv(), event, event.data.object, '+1', 7);
    await Promise.all(deferred.work);
    expect(redisMocks.logHealthError).toHaveBeenCalledWith('quo', 'Scheduling dispatch threw: gemini down', {
      eventId: 'evt-1',
      eventType: 'message.received',
    });
  });
});
