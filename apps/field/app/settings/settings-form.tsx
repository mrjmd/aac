'use client';

import { useActionState } from 'react';
import { saveHomeAddress, type SaveResult } from './actions';

const initialState: SaveResult = { ok: false };

export default function SettingsForm({ initialHomeAddress }: { initialHomeAddress: string }) {
  const [state, formAction, pending] = useActionState(saveHomeAddress, initialState);

  return (
    <form action={formAction} className="space-y-3">
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-aac-dark">Home address</span>
        <input
          type="text"
          name="homeAddress"
          defaultValue={initialHomeAddress}
          autoComplete="street-address"
          placeholder="123 Main St, Quincy, MA 02170"
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2.5 text-base text-aac-dark placeholder:text-zinc-400 focus:border-aac-blue focus:outline-none focus:ring-2 focus:ring-aac-blue/30"
        />
      </label>

      {state.error && (
        <p className="text-sm text-red-700">{state.error}</p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-aac-blue px-4 py-3 text-sm font-bold uppercase tracking-wide text-white shadow-sm active:bg-aac-blue/85 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}
