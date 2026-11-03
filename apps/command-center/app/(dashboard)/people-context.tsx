"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { Person } from "@aac/items";

interface PeopleApi {
  people: Person[];
  /** One /api/people op; the saved person replaces the local copy. Null on failure. */
  change: (body: Record<string, unknown>) => Promise<Person | null>;
}

const Ctx = createContext<PeopleApi | null>(null);

/** Everyone on the People page, shared with Today's conversations section, the rail count and the item ⋯ panel. */
export function PeopleProvider({ initial, children }: { initial: Person[]; children: React.ReactNode }) {
  const [people, setPeople] = useState<Person[]>(initial);

  const change = useCallback(async (body: Record<string, unknown>) => {
    const res = await fetch("/api/people", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const saved = (await res.json()) as Person;
    setPeople((all) =>
      all.some((p) => p.id === saved.id) ? all.map((p) => (p.id === saved.id ? saved : p)) : [...all, saved],
    );
    return saved;
  }, []);

  const api = useMemo(() => ({ people, change }), [people, change]);
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function usePeople(): PeopleApi {
  const api = useContext(Ctx);
  if (!api) throw new Error("usePeople outside PeopleProvider");
  return api;
}
