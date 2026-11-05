import { describe, it, expect } from 'vitest';
import { isBusyEvent, isTechOutOfOffice, selectBusyEvents, technicianEmails } from '../calendar';

const TECH = ['mike@attackacrack.com', 'harrringtonm@gmail.com'];
const ev = (summary: string, attendees: string[] = [], colorId?: string) => ({ summary, attendees, colorId });

describe('selectBusyEvents', () => {
  it('keeps Mike-attended events and drops Zoom/private/non-tech events', () => {
    const kept = selectBusyEvents(
      [
        ev('Jane Smith — crack injection', ['Mike@AttackACrack.com']),
        ev('Ed / Matt 121', ['ed@example.com']),
        ev('BNI Plus'),
        ev('Dentist'),
      ],
      TECH,
    );
    expect(kept.map((e) => e.summary)).toEqual(['Jane Smith — crack injection']);
  });

  it('keeps attendee-less HOLD placeholders', () => {
    const kept = selectBusyEvents([ev('HOLD — John Smith'), ev('Holiday party')], TECH);
    expect(kept.map((e) => e.summary)).toEqual(['HOLD — John Smith']);
  });

  it('never blocks on color alone (uninvited job, callback, graphite)', () => {
    expect(isBusyEvent(ev('Ann Joffre', [], '10'), TECH)).toBe(false);
    expect(isBusyEvent(ev('Ann Joffre callback', [], '5'), TECH)).toBe(false);
    expect(isBusyEvent(ev('Matt personal block', [], '8'), TECH)).toBe(false);
    expect(isBusyEvent(ev('HOLD — Ann Joffre', [], '8'), TECH)).toBe(true);
  });

  it('keeps everything when no technician emails are configured (degraded mode)', () => {
    const events = [ev('Ed / Matt 121', ['ed@example.com']), ev('BNI Plus')];
    expect(selectBusyEvents(events, [])).toEqual(events);
  });

  it('keeps attendee-less Mike OOO entries (2026-10-15 gap)', () => {
    const kept = selectBusyEvents(
      [
        ev('Mike OOO'),
        ev('Mike out of office'),
        ev('mike ooo — hunting trip'),
        ev('Matt OOO'), // Matt's absence never blocks Mike's jobs
        ev('OOO'), // ambiguous: whose? don't block
        ev('Smith vacation home — crack injection'), // customer event, not OOO
      ],
      TECH,
    );
    expect(kept.map((e) => e.summary)).toEqual(['Mike OOO', 'Mike out of office', 'mike ooo — hunting trip']);
  });
});

describe('isTechOutOfOffice', () => {
  it('ignores "off" and "away" in unrelated titles (stale-quotes regex bug)', () => {
    expect(isTechOutOfOffice('Drop off check at bank')).toBe(false);
    expect(isTechOutOfOffice('Matt away')).toBe(false);
    expect(isTechOutOfOffice('Kickoff call')).toBe(false);
    expect(isTechOutOfOffice(undefined)).toBe(false);
  });
});

describe('technicianEmails', () => {
  it('parses the env list or falls back to the default', () => {
    expect(technicianEmails(' A@x.com, b@y.com ,')).toEqual(['a@x.com', 'b@y.com']);
    expect(technicianEmails(undefined)).toEqual(TECH);
    expect(technicianEmails('')).toEqual(TECH);
  });
});
