import { describe, expect, it } from 'vitest';
import { buildMonthlyRevenue, buildTech2Gates, winterMonths } from '../src/index.js';
import type { CashAccount } from '../src/index.js';

const inv = (TxnDate: string, TotalAmt: number) => ({ TxnDate, TotalAmt });

describe('buildMonthlyRevenue', () => {
  const invoices = [
    inv('2025-08-05', 30_000),
    inv('2025-09-10', 15_000),
    inv('2025-10-02', 30_000),
    inv('2025-10-20', 3_000),
    inv('2026-08-01', 29_600),
    inv('2026-09-01', 49_275),
    inv('2026-10-01', 41_845),
    inv('2026-11-03', 275),
  ];

  it('sums invoices by month, rolls three closed months, and stops at the open month', () => {
    const r = buildMonthlyRevenue(invoices, '2026-11-07');
    const oct = r.months.find((m) => m.month === '2026-10')!;
    expect(oct.revenue).toBe(41_845);
    expect(oct.rolling3).toBe(Math.round((29_600 + 49_275 + 41_845) / 3));
    expect(oct.lastYear).toBe(33_000);
    const nov = r.months[r.months.length - 1]!;
    expect(nov).toMatchObject({ month: '2026-11', revenue: 275, open: true, rolling3: null });
    expect(r.rolling3).toBe(40_240);
    expect(r.months[0]!.month).toBe('2025-06');
  });

  it('TTM is the last 12 closed months', () => {
    const r = buildMonthlyRevenue(invoices, '2026-11-07');
    expect(r.ttm).toBe(29_600 + 49_275 + 41_845);
  });
});

describe('winterMonths', () => {
  it('is Nov-Feb around today, the coming one before November', () => {
    expect(winterMonths('2026-11-07')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
    expect(winterMonths('2027-01-15')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
    expect(winterMonths('2026-09-01')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
  });
});

describe('buildTech2Gates', () => {
  const account = (name: string, qboBalance: number, bank: CashAccount['bank'] = 'Relay'): CashAccount => ({
    id: name,
    name,
    bank,
    qboBalance,
    postedThrough: null,
    daysBehind: null,
  });

  it('judges this winter against last winter × 1.5, so far against the same months', () => {
    const g = buildTech2Gates({
      invoices: [inv('2025-11-10', 17_350), inv('2025-12-10', 9_100), inv('2026-01-10', 6_000), inv('2026-02-10', 15_275), inv('2026-11-03', 26_025)],
      cash: null,
      bookedWeeks: [],
      today: '2026-12-05',
    });
    expect(g.winter.lastWinter).toBe(47_725);
    expect(g.winter.needed).toBe(71_588);
    expect(g.winter.monthsIn).toBe(2);
    expect(g.winter.multiplierSoFar).toBe(1.5);
  });

  it('an open month counts toward the total but not the multiplier', () => {
    const g = buildTech2Gates({ invoices: [inv('2025-11-10', 17_350), inv('2026-11-03', 275)], cash: null, bookedWeeks: [], today: '2026-11-07' });
    expect(g.winter.thisWinter).toBe(275);
    expect(g.winter.monthsIn).toBe(1);
    expect(g.winter.multiplierSoFar).toBeNull();
  });

  it('reads the reserve (Payroll + Opex) and hire fund (New Technician) from Relay only', () => {
    const g = buildTech2Gates({
      invoices: [],
      cash: { accounts: [account('Payroll (6179)', 22_444.56), account('Opex (1081)', 7_712.53), account('New Technician (7440)', 4_323.08), account('Profit (1077)', 1_674), account('Business Checking (1082) - 1', -14_080, 'Beacon')] },
      bookedWeeks: [1.2, null, 3.1, 2.4],
      today: '2026-11-07',
    });
    expect(g.reserve.balance).toBe(30_157);
    expect(g.hireFund.balance).toBe(4_323);
    expect(g.vaults.balance).toBe(34_480);
    expect(g.booked).toEqual({ latest: 2.4, weeksAtGate: 1, weeksSeen: 3 });
  });
});
