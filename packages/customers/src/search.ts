import type { QBCustomer } from '@aac/api-clients/quickbooks';
import { quickNormalizePhone } from '@aac/shared-utils/phone';
import { nameTokens, tokensAlike } from './match.js';

export interface CustomerHit {
  id: string;
  name: string;
  company?: string;
  phone?: string;
  email?: string;
  address?: string;
  active: boolean;
  matchedBy: 'phone' | 'email' | 'name' | 'address';
}

/** Keep only the fields search and display use, so the full list stays small to store. */
export function trimCustomer(c: QBCustomer): QBCustomer {
  const keep = <K extends keyof QBCustomer>(k: K) => (c[k] !== undefined ? { [k]: c[k] } : {});
  return {
    Id: c.Id,
    DisplayName: c.DisplayName,
    ...keep('CompanyName'),
    ...keep('PrimaryPhone'),
    ...keep('Mobile'),
    ...keep('AlternatePhone'),
    ...keep('PrimaryEmailAddr'),
    ...(c.BillAddr ? { BillAddr: { Line1: c.BillAddr.Line1, City: c.BillAddr.City } } : {}),
    ...keep('Active'),
  };
}

/**
 * Find customers by whatever Matt types: a name (typo-tolerant), a phone
 * in any format, an email, or part of an address. Best matches first.
 */
export function searchCustomers(customers: QBCustomer[], query: string, limit = 25): CustomerHit[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const digits = q.replace(/\D/g, '');
  const phone = digits.length >= 7 ? quickNormalizePhone(digits) : null;
  const qTokens = nameTokens(q);

  const scored: Array<{ hit: CustomerHit; score: number }> = [];
  for (const c of customers) {
    if (!c.Id) continue;
    const phones = [c.PrimaryPhone, c.Mobile, c.AlternatePhone].map((p) => p?.FreeFormNumber ?? '').filter(Boolean);
    const email = c.PrimaryEmailAddr?.Address?.toLowerCase() ?? '';
    const addr = [c.BillAddr?.Line1, c.BillAddr?.City].filter(Boolean).join(', ');
    const name = `${c.DisplayName} ${c.CompanyName ?? ''}`;

    let matchedBy: CustomerHit['matchedBy'] | null = null;
    let score = 0;
    if (digits.length >= 7 && phones.some((p) => (phone && quickNormalizePhone(p) === phone) || p.replace(/\D/g, '').includes(digits))) {
      matchedBy = 'phone';
      score = 100;
    } else if (q.includes('@') ? email.includes(q) : false) {
      matchedBy = 'email';
      score = 90;
    } else if (name.toLowerCase().includes(q)) {
      matchedBy = 'name';
      score = name.toLowerCase().startsWith(q) ? 80 : 70;
    } else if (qTokens.length && qTokens.every((t) => nameTokens(name).some((n) => tokensAlike(n, t)))) {
      matchedBy = 'name';
      score = 60;
    } else if (/\d/.test(q) && addr.toLowerCase().includes(q)) {
      matchedBy = 'address';
      score = 50;
    } else if (!/\d/.test(q) && q.length >= 4 && addr.toLowerCase().includes(q)) {
      matchedBy = 'address';
      score = 40;
    }
    if (!matchedBy) continue;
    if (c.Active === false) score -= 5;
    scored.push({
      score,
      hit: {
        id: c.Id,
        name: c.DisplayName,
        company: c.CompanyName && c.CompanyName !== c.DisplayName ? c.CompanyName : undefined,
        phone: phones[0],
        email: email || undefined,
        address: addr || undefined,
        active: c.Active !== false,
        matchedBy,
      },
    });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.hit.name.localeCompare(b.hit.name))
    .slice(0, limit)
    .map((s) => s.hit);
}
