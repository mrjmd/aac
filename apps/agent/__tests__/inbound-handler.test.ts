import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleInboundAgentMessage,
  type ParsedInboundEvent,
  type InboundDeps,
} from '../lib/inbound-handler.js';
import type { AgentRole } from '../lib/roles.js';

const AGENT_LINE = '+16177660151';
const MATT = '+18287724836';
const MIKE = '+15555550001';

function makeDeps(overrides: Partial<InboundDeps> = {}): InboundDeps {
  const base: InboundDeps = {
    quo: { sendMessage: vi.fn().mockResolvedValue({ id: 'sms-1' }) },
    audit: vi.fn().mockResolvedValue(undefined),
    agentPhoneNumber: AGENT_LINE,
    roleMap: { [MATT]: 'owner', [MIKE]: 'technician' } as Record<string, AgentRole>,
    now: () => new Date('2026-05-28T18:00:00.000Z'),
  };
  return { ...base, ...overrides };
}

function makeEvent(overrides: Partial<ParsedInboundEvent> = {}): ParsedInboundEvent {
  return {
    eventId: 'evt_1',
    type: 'message.received',
    to: AGENT_LINE,
    from: MATT,
    body: 'check the Davis deal',
    messageId: 'msg_1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleInboundAgentMessage', () => {
  it('acks owner messages and sends reply from the agent line', async () => {
    const deps = makeDeps();
    const result = await handleInboundAgentMessage(makeEvent(), deps);

    expect(result.decision).toBe('ack');
    expect(deps.quo.sendMessage).toHaveBeenCalledOnce();
    expect(deps.quo.sendMessage).toHaveBeenCalledWith(
      MATT,
      expect.stringContaining('check the Davis deal'),
      AGENT_LINE,
    );
    expect(deps.audit).toHaveBeenCalledOnce();
    const audited = (deps.audit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(audited.decision).toBe('ack');
    expect(audited.caller).toBe(MATT);
    expect(audited.role).toBe('owner');
    expect(audited.replyText).toBeDefined();
  });

  it('ignores known non-owner roles (Walk-1 stub policy) without replying', async () => {
    const deps = makeDeps();
    const result = await handleInboundAgentMessage(
      makeEvent({ from: MIKE, eventId: 'evt_2', messageId: 'msg_2' }),
      deps,
    );

    expect(result.decision).toBe('ignore');
    expect(deps.quo.sendMessage).not.toHaveBeenCalled();
    const audited = (deps.audit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(audited.decision).toBe('ignore');
    expect(audited.role).toBe('technician');
  });

  it('drops messages from unknown senders silently, audits as unknown_caller', async () => {
    const deps = makeDeps();
    const result = await handleInboundAgentMessage(
      makeEvent({ from: '+19998887777', eventId: 'evt_3' }),
      deps,
    );

    expect(result.decision).toBe('unknown_caller');
    expect(deps.quo.sendMessage).not.toHaveBeenCalled();
    const audited = (deps.audit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(audited.decision).toBe('unknown_caller');
    expect(audited.caller).toBe('+19998887777');
    expect(audited.role).toBe('unknown');
  });

  it('audits wrong_line when message is to a different number', async () => {
    const deps = makeDeps();
    const result = await handleInboundAgentMessage(
      makeEvent({ to: '+16176681677', eventId: 'evt_4' }), // main business line
      deps,
    );

    expect(result.decision).toBe('wrong_line');
    expect(deps.quo.sendMessage).not.toHaveBeenCalled();
    const audited = (deps.audit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(audited.decision).toBe('wrong_line');
  });

  it('audits unsupported_event for call.completed and similar', async () => {
    const deps = makeDeps();
    const result = await handleInboundAgentMessage(
      makeEvent({ type: 'call.completed', body: '', eventId: 'evt_5' }),
      deps,
    );

    expect(result.decision).toBe('unsupported_event');
    expect(deps.quo.sendMessage).not.toHaveBeenCalled();
  });

  it('audits unsupported_event for message.delivered (our own outbound ack)', async () => {
    const deps = makeDeps();
    const result = await handleInboundAgentMessage(
      makeEvent({ type: 'message.delivered', eventId: 'evt_6' }),
      deps,
    );

    expect(result.decision).toBe('unsupported_event');
    expect(deps.quo.sendMessage).not.toHaveBeenCalled();
  });

  it('handles unknown sender phone (no `from` field)', async () => {
    const deps = makeDeps();
    const result = await handleInboundAgentMessage(
      makeEvent({ from: undefined, eventId: 'evt_7' }),
      deps,
    );

    expect(result.decision).toBe('unknown_caller');
    const audited = (deps.audit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(audited.caller).toBe('unknown');
  });

  it('on Quo send failure, audits the attempt with a [send failed: ...] prefix then rethrows', async () => {
    const deps = makeDeps({
      quo: { sendMessage: vi.fn().mockRejectedValueOnce(new Error('quo 500')) },
    });

    await expect(
      handleInboundAgentMessage(makeEvent({ eventId: 'evt_8' }), deps),
    ).rejects.toThrow('quo 500');

    expect(deps.audit).toHaveBeenCalledOnce();
    const audited = (deps.audit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(audited.decision).toBe('ack');
    expect(audited.replyText).toContain('[send failed: quo 500]');
  });

  it('normalizes the sender phone before role lookup (so loose E.164 still matches)', async () => {
    const deps = makeDeps();
    // Same digits, but raw without leading +. normalizePhone should produce
    // +18287724836, which IS in the role map.
    const result = await handleInboundAgentMessage(
      makeEvent({ from: '18287724836', eventId: 'evt_9' }),
      deps,
    );
    expect(result.decision).toBe('ack');
  });
});
