/**
 * Triage's token-based address match (D4/D9). Moved verbatim from
 * tools/src/triage/analyze.ts. It stays here rather than in
 * @aac/shared-utils/address because it is built on @aac/customers'
 * nameTokens/tokensAlike, and shared-utils cannot depend on customers.
 */

import { nameTokens, tokensAlike } from '@aac/customers';

// Generic street words carry no identity — only the street *name* joins.
const STREET_STOP = new Set([
  'street', 'avenue', 'road', 'drive', 'lane', 'court', 'place', 'circle',
  'terrace', 'unit', 'apt', 'suite', 'ave',
]);

/**
 * Address identity for matching. Third-party-payer jobs (realtor or law
 * office pays at closing) are invoiced under the payer's name, so the
 * property address is the only reliable join — but single street tokens
 * are far too weak ("Iron Hill" matched "Oak Hill" on 'hill', "S Main"
 * matched "North Main" on 'main'). Two addresses are alike only when the
 * house numbers agree AND a street-name token matches; with no number on
 * either side, every token of the shorter list must match.
 */
export interface AddrKey {
  num: string | null;
  toks: string[];
}

export function addrKey(line: string): AddrKey {
  const seg = line.split(',')[0];
  return {
    num: (seg.match(/\d+/) ?? [null])[0],
    toks: nameTokens(seg).filter((t) => !STREET_STOP.has(t)),
  };
}

/** The address fields of a raw QBO estimate/invoice that addrKeys reads. */
export interface AddressedTxn {
  BillAddr?: { Line1?: string; Line2?: string };
  ShipAddr?: { Line1?: string; Line2?: string };
}

/**
 * One key per address line (QBO free-form addresses often put the customer
 * name in Line1 and the street in Line2 — flattening them would let name
 * tokens pollute the street match).
 */
export function addrKeys(txn: AddressedTxn): AddrKey[] {
  const keys: AddrKey[] = [];
  for (const a of [txn.BillAddr, txn.ShipAddr]) {
    if (a?.Line1) keys.push(addrKey(a.Line1));
    if (a?.Line2) keys.push(addrKey(a.Line2));
  }
  return keys.filter((k) => k.toks.length > 0);
}

export function addrsAlike(a: AddrKey, b: AddrKey): boolean {
  if (a.toks.length === 0 || b.toks.length === 0) return false;
  if (!a.toks.some((t) => b.toks.some((s) => tokensAlike(s, t)))) return false;
  if (a.num && b.num) return a.num === b.num;
  const [short, long] = a.toks.length <= b.toks.length ? [a.toks, b.toks] : [b.toks, a.toks];
  return short.every((t) => long.some((s) => tokensAlike(s, t)));
}
