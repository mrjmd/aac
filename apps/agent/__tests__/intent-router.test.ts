import { describe, it, expect } from 'vitest';
import { routeIntent } from '../lib/intent-router.js';

describe('routeIntent (stub)', () => {
  it('acks owner messages with a receipt confirmation', () => {
    const decision = routeIntent({
      callerPhoneE164: '+18287724836',
      role: 'owner',
      messageBody: 'hey check on the Davis deal',
      messageId: 'msg_1',
    });
    expect(decision.type).toBe('ack');
    if (decision.type === 'ack') {
      expect(decision.replyText).toContain('hey check on the Davis deal');
      expect(decision.replyText.toLowerCase()).toContain("isn't live");
    }
  });

  it('truncates long owner messages in the echo', () => {
    const long = 'a'.repeat(500);
    const decision = routeIntent({
      callerPhoneE164: '+18287724836',
      role: 'owner',
      messageBody: long,
      messageId: 'msg_2',
    });
    expect(decision.type).toBe('ack');
    if (decision.type === 'ack') {
      // Reply must not contain the full 500-char body verbatim
      expect(decision.replyText.length).toBeLessThan(250);
      expect(decision.replyText).toContain('...');
    }
  });

  it('ignores technician messages (placeholder role at Walk start)', () => {
    const decision = routeIntent({
      callerPhoneE164: '+15551234567',
      role: 'technician',
      messageBody: 'whats on my schedule today',
      messageId: 'msg_3',
    });
    expect(decision.type).toBe('ignore');
    if (decision.type === 'ignore') {
      expect(decision.reason).toContain('technician');
    }
  });

  it('ignores salesperson and triage as well', () => {
    for (const role of ['salesperson', 'triage'] as const) {
      const decision = routeIntent({
        callerPhoneE164: '+15550000000',
        role,
        messageBody: 'hi',
        messageId: 'm',
      });
      expect(decision.type).toBe('ignore');
    }
  });
});
