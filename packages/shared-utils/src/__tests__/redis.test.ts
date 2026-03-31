import { describe, it, expect } from 'vitest';
import { keys, ttl } from '../redis.js';

describe('keys', () => {
  describe('health & observability', () => {
    it('builds heartbeat key', () => {
      expect(keys.heartbeat('middleware')).toBe('health:middleware:ts');
    });

    it('builds webhook count key', () => {
      expect(keys.webhookCount('pipedrive', '2026-03-31')).toBe('webhooks:pipedrive:2026-03-31:count');
    });

    it('builds webhook last key', () => {
      expect(keys.webhookLast('quo')).toBe('webhooks:quo:last');
    });

    it('has health errors key', () => {
      expect(keys.healthErrors).toBe('health:errors');
    });

    it('has webhook audit stream key', () => {
      expect(keys.webhookAuditStream).toBe('logs:webhooks');
    });
  });

  describe('deduplication', () => {
    it('builds dedupe key', () => {
      expect(keys.dedupe('pipedrive', 'evt-123')).toBe('dedupe:pipedrive:evt-123');
    });
  });

  describe('ID mapping', () => {
    it('builds bidirectional Pipedrive-Quo keys', () => {
      expect(keys.map.pipedriveToQuo('pd-1')).toBe('map:pd-to-quo:pd-1');
      expect(keys.map.quoToPipedrive('quo-1')).toBe('map:quo-to-pd:quo-1');
    });

    it('builds bidirectional Pipedrive-QB keys', () => {
      expect(keys.map.pipedriveToQb('pd-1')).toBe('map:pd-to-qb:pd-1');
      expect(keys.map.qbToPipedrive('qb-1')).toBe('map:qb-to-pd:qb-1');
    });

    it('builds phone-to-Pipedrive key', () => {
      expect(keys.map.phoneToPipedrive('+15551234567')).toBe('phone:pd:+15551234567');
    });
  });

  describe('loop prevention', () => {
    it('builds created-by-us key', () => {
      expect(keys.createdByUs('pd', '12345')).toBe('created-by-us:pd:12345');
    });
  });

  describe('QuickBooks OAuth', () => {
    it('has QB OAuth tokens key', () => {
      expect(keys.qbOAuthTokens).toBe('oauth:quickbooks:tokens');
    });
  });

  describe('campaign state', () => {
    it('builds campaign keys', () => {
      expect(keys.campaign('camp-1')).toBe('campaign:camp-1');
      expect(keys.campaignContacts('camp-1')).toBe('campaign:camp-1:contacts');
    });

    it('has campaigns active key', () => {
      expect(keys.campaignsActive).toBe('campaigns:active');
    });

    it('builds campaign stats key', () => {
      expect(keys.campaignStats('camp-1')).toBe('stats:campaign:camp-1');
    });
  });

  describe('suppression lists', () => {
    it('has static suppression keys', () => {
      expect(keys.optouts).toBe('optouts:phones');
      expect(keys.suppressionDnc).toBe('suppression:dnc');
      expect(keys.suppressionLitigators).toBe('suppression:litigators');
      expect(keys.suppressionLandlines).toBe('suppression:landlines');
    });
  });

  describe('attribution', () => {
    it('builds attribution keys', () => {
      expect(keys.attribution('inv-1')).toBe('attribution:inv-1');
      expect(keys.attributionProcessed('inv-1')).toBe('attribution:processed:inv-1');
    });
  });
});

describe('ttl', () => {
  it('has correct TTL values', () => {
    expect(ttl.dedupe).toBe(86_400);          // 24 hours
    expect(ttl.idMapping).toBe(604_800);      // 7 days
    expect(ttl.loopPrevention).toBe(60);      // 60 seconds
    expect(ttl.webhookCount).toBe(172_800);   // 48 hours
    expect(ttl.campaign).toBe(7_776_000);     // 90 days
    expect(ttl.attribution).toBe(31_536_000); // 1 year
  });
});
