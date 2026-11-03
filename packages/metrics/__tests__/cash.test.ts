import { describe, it, expect } from 'vitest';
import { buildCashPosition } from '../src/index.js';

describe('buildCashPosition', () => {
  const accounts = [
    { Id: '40', Name: 'Connecticut Sealers LLC - Opex (1081)', AccountType: 'Bank', CurrentBalance: 7712.53, Active: true },
    { Id: '44', Name: 'Connecticut Sealers LLC - Payroll (6179)', AccountType: 'Bank', CurrentBalance: 22444.56, Active: true },
    { Id: '17', Name: 'Business Checking (1082) - 1', AccountType: 'Bank', CurrentBalance: -14080.65, Active: true },
    { Id: '99', Name: 'Old account', AccountType: 'Bank', CurrentBalance: 5, Active: false },
    { Id: '8', Name: 'Undeposited Funds', AccountType: 'Other Current Asset', CurrentBalance: 48500 },
    { Id: '7', Name: 'Accounts Receivable (A/R)', AccountType: 'Accounts Receivable', CurrentBalance: 37691.67 },
  ];

  const position = buildCashPosition({
    accounts,
    postingDates: { '40': '2026-10-27', '44': '2026-10-23' },
    openInvoices: [
      { Id: 'a', Balance: 7800, DueDate: '2026-07-03' },
      { Id: 'b', Balance: 1950, DueDate: '2026-06-25' },
      { Id: 'c', Balance: 500, DueDate: '2026-11-20' },
    ] as never,
    today: '2026-11-03',
    postingWindowStart: '2026-08-05',
  });

  it('lists active bank registers, Relay first, with short names', () => {
    expect(position.accounts.map((a) => [a.name, a.bank])).toEqual([
      ['Payroll (6179)', 'Relay'],
      ['Opex (1081)', 'Relay'],
      ['Business Checking (1082) - 1', 'Beacon'],
    ]);
    expect(position.relayTotal).toBe(30157.09);
  });

  it('dates each register and counts days behind', () => {
    expect(position.accounts[0]).toMatchObject({ postedThrough: '2026-10-23', daysBehind: 11 });
    expect(position.accounts[2]).toMatchObject({ postedThrough: null, daysBehind: null });
  });

  it('reports undeposited funds and AR with overdue split', () => {
    expect(position.undeposited).toBe(48500);
    expect(position.ar).toEqual({
      openTotal: 10250,
      openCount: 3,
      overdueTotal: 9750,
      overdueCount: 2,
      oldestDue: '2026-06-25',
    });
  });
});
