import { describe, it, expect } from 'vitest';
import { nudgeStatus, type TimelineEntry } from '../src/index.js';

const e = (over: Partial<TimelineEntry>): TimelineEntry =>
  ({ id: Math.random().toString(), kind: 'text', at: '2026-10-01T15:00:00Z', title: 'Text to customer', direction: 'out', ...over }) as TimelineEntry;

describe('nudgeStatus', () => {
  it('nothing due before day 7', () => {
    expect(nudgeStatus('2026-10-01', [], '2026-10-05').next).toBeNull();
  });
  it('day 10 with no touch: QBO reminder is next', () => {
    expect(nudgeStatus('2026-10-01', [], '2026-10-11')).toMatchObject({ daysOverdue: 10, next: { kind: 'reminder' }, behind: 0 });
  });
  it('a payment text after the due date covers reminder and text', () => {
    const s = nudgeStatus('2026-10-01', [e({ at: '2026-10-09T15:00:00Z', detail: 'Hi, just a reminder the invoice is due' })], '2026-10-20');
    expect(s.next).toBeNull();
    expect(s.history).toHaveLength(1);
  });
  it('ignores scheduling texts, inbound messages and touches before the due date', () => {
    const s = nudgeStatus(
      '2026-10-01',
      [
        e({ at: '2026-10-09T15:00:00Z', detail: 'Mike will be there at 8' }),
        e({ at: '2026-10-09T15:00:00Z', direction: 'in', detail: 'I will pay Friday' }),
        e({ at: '2026-09-20T15:00:00Z', detail: 'invoice attached' }),
      ],
      '2026-10-20',
    );
    expect(s.history).toHaveLength(0);
    expect(s.next?.kind).toBe('reminder');
    expect(s.behind).toBe(1);
  });
  it('an outbound call covers through the call rung; final notice stays manual', () => {
    const s = nudgeStatus('2026-08-01', [e({ kind: 'call', at: '2026-09-05T15:00:00Z', title: 'Call to customer (3 min)' })], '2026-10-01');
    expect(s.next).toMatchObject({ kind: 'final', day: 45 });
  });
});

describe('nudgeTouch', () => {
  it("counts QBO's automatic reminder emails as step 1 even though they arrive as inbound", () => {
    const s = nudgeStatus(
      '2026-07-22',
      [e({ kind: 'email', direction: 'in', at: '2026-07-25T13:00:00Z', title: 'Invoice - Reminder: Your payment to Attack A Crack is due' })],
      '2026-08-01',
    );
    expect(s.history[0]).toMatchObject({ kind: 'reminder' });
    expect(s.next).toBeNull();
  });
});

describe('payment wording', () => {
  it('quote emails and "I\'ll check" texts are not nudges', () => {
    const s = nudgeStatus(
      '2026-10-01',
      [
        e({ kind: 'email', at: '2026-10-09T15:00:00Z', title: 'Re: Rivercourt Estimate - Quote 1342 from Attack A Crack', detail: 'payment terms attached' }),
        e({ at: '2026-10-09T15:00:00Z', detail: "I'll check with Mike and get back to you" }),
      ],
      '2026-10-20',
    );
    expect(s.history).toHaveLength(0);
  });
  it('"sent the check" style texts still count', () => {
    expect(nudgeStatus('2026-10-01', [e({ at: '2026-10-09T15:00:00Z', detail: 'Did you send the check yet?' })], '2026-10-20').history).toHaveLength(1);
  });
});
