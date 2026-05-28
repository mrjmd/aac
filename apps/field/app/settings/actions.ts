'use server';

import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/session';
import { getUserConfig, saveUserConfig } from '@/lib/user-config';

export interface SaveResult {
  ok: boolean;
  error?: string;
}

export async function saveHomeAddress(
  _prev: SaveResult,
  formData: FormData,
): Promise<SaveResult> {
  const session = await requireSession();
  const raw = String(formData.get('homeAddress') ?? '').trim();
  // Empty string = "clear my override, fall back to the default"
  const homeAddress = raw.length > 0 ? raw : null;

  const existing = await getUserConfig(session.email);
  await saveUserConfig(session.email, { ...existing, homeAddress });

  redirect('/settings?saved=1');
}
