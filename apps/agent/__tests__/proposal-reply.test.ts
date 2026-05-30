import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StoredProposal } from '@aac/scheduling';
import {
  classifyProposalReply,
  handleProposalReply,
  type ProposalReplyDeps,
} from '../lib/proposal-reply.js';

function makeProposal(): StoredProposal {
  return {
    proposalId: 'prop_1',
    directive: {
      id: 'dir_1',
      intent: 'quote_approved',
      eventClass: 'job',
      customerName: 'John Smith',
      customerPhone: '+16175550123',
      scopeSummary: 'crack injection rear wall',
    },
    slot: {
      startIso: '2026-06-02T13:00:00.000Z',
      endIso: '2026-06-02T17:00:00.000Z',
      reasoning: 'next available weekday',
    },
    eventDescription: '...',
    descriptionUsedFallback: false,
    createdAt: '2026-05-30T12:00:00.000Z',
    ownerPhoneE164: '+18287724836',
    smsId: 'msg_1',
  };
}

function makeDeps(overrides: Partial<ProposalReplyDeps> = {}): ProposalReplyDeps {
  return {
    quo: { sendMessage: vi.fn().mockResolvedValue({ id: 'ack_1' }) },
    clearActiveProposalForOwner: vi.fn().mockResolvedValue(undefined),
    postDecisionCallback: vi.fn().mockResolvedValue(true),
    agentPhoneNumber: '+16177660151',
    now: () => new Date('2026-05-30T12:00:00.000Z'),
    ...overrides,
  };
}

describe('classifyProposalReply', () => {
  it.each([
    ['yes', 'approved'],
    ['Yes!', 'approved'],
    ['y', 'approved'],
    ['ok', 'approved'],
    ['confirm', 'approved'],
    ['lgtm', 'approved'],
    ['no', 'rejected'],
    ['N.', 'rejected'],
    ['skip', 'rejected'],
    ['cancel', 'rejected'],
    ['pass', 'rejected'],
    ['thu 1pm', 'edit'],
    ['make it tuesday', 'edit'],
    ['', 'edit'],
    ['probably?', 'edit'],
  ])('classifies %s as %s', (input, expected) => {
    expect(classifyProposalReply(input)).toBe(expected);
  });
});

describe('handleProposalReply', () => {
  beforeEach(() => vi.clearAllMocks());

  it('posts approval to middleware, acks Matt, clears active pointer', async () => {
    const deps = makeDeps();
    const result = await handleProposalReply(makeProposal(), 'yes', deps);
    expect(result.decision).toBe('approved');
    expect(result.callbackOk).toBe(true);
    expect(deps.postDecisionCallback).toHaveBeenCalledWith({
      proposalId: 'prop_1',
      directiveId: 'dir_1',
      decision: 'approved',
      replyText: 'yes',
      decidedAt: '2026-05-30T12:00:00.000Z',
    });
    expect(deps.quo.sendMessage).toHaveBeenCalledWith(
      '+18287724836',
      expect.stringContaining('approved for John Smith'),
      '+16177660151',
    );
    expect(deps.clearActiveProposalForOwner).toHaveBeenCalledWith('+18287724836');
  });

  it('posts rejection with the right wording', async () => {
    const deps = makeDeps();
    const result = await handleProposalReply(makeProposal(), 'no', deps);
    expect(result.decision).toBe('rejected');
    const ack = (deps.quo.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(ack).toContain("won't schedule John Smith");
    expect(ack).toContain('rejected');
  });

  it('records edits verbatim with a snippet in the ack', async () => {
    const deps = makeDeps();
    const result = await handleProposalReply(makeProposal(), 'make it Thursday 1pm instead', deps);
    expect(result.decision).toBe('edit');
    expect(deps.postDecisionCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'edit',
        replyText: 'make it Thursday 1pm instead',
      }),
    );
    const ack = (deps.quo.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(ack).toContain('make it Thursday 1pm instead');
  });

  it('still acks Matt + clears pointer when callback fails', async () => {
    const deps = makeDeps({ postDecisionCallback: vi.fn().mockResolvedValue(false) });
    const result = await handleProposalReply(makeProposal(), 'yes', deps);
    expect(result.callbackOk).toBe(false);
    expect(deps.quo.sendMessage).toHaveBeenCalled();
    const ack = (deps.quo.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(ack).toContain('callback failed');
    expect(deps.clearActiveProposalForOwner).toHaveBeenCalled();
  });

  it('clears active pointer even when ack SMS send throws', async () => {
    const deps = makeDeps({
      quo: { sendMessage: vi.fn().mockRejectedValue(new Error('quo down')) },
    });
    const result = await handleProposalReply(makeProposal(), 'yes', deps);
    expect(result.decision).toBe('approved');
    expect(deps.clearActiveProposalForOwner).toHaveBeenCalled();
  });

  it('truncates very long edit replies in the ack', async () => {
    const deps = makeDeps();
    const longEdit = 'x'.repeat(500);
    await handleProposalReply(makeProposal(), longEdit, deps);
    const ack = (deps.quo.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(ack).toContain('...');
    // Ack should be tractable in SMS, but we only enforce the snippet bound
    expect(ack.length).toBeLessThan(300);
  });
});
