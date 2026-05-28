/**
 * Per-technician app configuration. Currently just the home address, but
 * shaped as an object so future settings (notification prefs, default
 * payment method, etc.) can land here without changing the storage layer.
 *
 * Lives in Redis under a per-email key, written from the /settings page.
 */

import { keys } from '@aac/shared-utils/redis';
import { getRedis } from './clients';

export interface UserConfig {
  /** Free-text address where the day starts/ends. Used by travel-time. */
  homeAddress: string | null;
}

const EMPTY_CONFIG: UserConfig = { homeAddress: null };

export async function getUserConfig(email: string): Promise<UserConfig> {
  const stored = await getRedis().get<UserConfig>(keys.fieldUserConfig(email));
  return stored ?? EMPTY_CONFIG;
}

export async function saveUserConfig(email: string, config: UserConfig): Promise<void> {
  await getRedis().set(keys.fieldUserConfig(email), config);
}
