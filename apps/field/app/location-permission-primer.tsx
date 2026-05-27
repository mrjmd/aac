'use client';

import { useEffect } from 'react';

/**
 * Primes the browser's location permission state at app load — so the
 * "use your location?" prompt feels like an app-startup ask (Apple-style),
 * not a surveillance ask attached to the Check-In button.
 *
 * No UI. Discards the resulting fix. If permission is already granted or
 * denied, this is a true no-op.
 *
 * The component renders nothing; it only runs a one-shot effect.
 */
export default function LocationPermissionPrimer() {
  useEffect(() => {
    if (typeof window === 'undefined' || !navigator.geolocation) return;

    let cancelled = false;

    async function maybePrompt() {
      try {
        if ('permissions' in navigator) {
          // Modern browsers — check state first, only prompt if unset.
          const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
          if (status.state !== 'prompt') return;
        }
        if (cancelled) return;
        // Trigger the browser prompt. Discard the fix; we only wanted the dialog.
        navigator.geolocation.getCurrentPosition(
          () => { /* granted — coords discarded */ },
          () => { /* denied or failed — silent */ },
          { enableHighAccuracy: false, timeout: 10_000, maximumAge: Infinity },
        );
      } catch {
        // Permissions API unsupported or rejected — fall back: skip the primer.
        // CheckIn-time getCurrentPosition will still work and prompt if needed.
      }
    }

    void maybePrompt();
    return () => { cancelled = true; };
  }, []);

  return null;
}
