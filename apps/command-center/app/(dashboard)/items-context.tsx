"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Area, Item, Verb } from "@aac/items";
import type { ItemsView } from "@/lib/items";

type Confirm = "money" | "legal";

interface Toast {
  msg: string;
  undo?: () => Promise<void>;
}

interface ItemsApi {
  view: ItemsView | null;
  error: string;
  reload: () => Promise<void>;
  /** Returns the confirm kind when the server wants a confirmation first. */
  act: (key: string, verb: Verb) => Promise<Confirm | null>;
  mute: (item: Item, confirmed?: boolean) => Promise<Confirm | null>;
  reorder: (keys: string[]) => Promise<void>;
  toast: Toast | null;
  say: (msg: string, undo?: () => Promise<void>) => void;
  /** The item open in the details drawer. */
  open: Item | null;
  setOpen: (item: Item | null) => void;
}

const Ctx = createContext<ItemsApi | null>(null);

/** One items view (server-rendered, then /api/items after each verb) shared by the rail counts, Today and the area pages. */
export function ItemsProvider({ initial, children }: { initial: ItemsView | null; children: React.ReactNode }) {
  const [view, setView] = useState<ItemsView | null>(initial);
  const [error, setError] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);
  const [open, setOpen] = useState<Item | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(async () => {
    const res = await fetch("/api/items", { cache: "no-store" });
    if (!res.ok) {
      setError(`Couldn't load items (${res.status})`);
      return;
    }
    setError("");
    setView((await res.json()) as ItemsView);
  }, []);

  // The layout renders the first view on the server; refetch only if that failed.
  useEffect(() => {
    if (!initial) void reload();
  }, [initial, reload]);

  const act = useCallback(
    async (key: string, verb: Verb): Promise<Confirm | null> => {
      const res = await fetch("/api/items/verb", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, verb }),
      });
      if (res.status === 409) return ((await res.json()) as { confirm: Confirm }).confirm;
      if (!res.ok) setError(`That didn't save (${res.status})`);
      await reload();
      return null;
    },
    [reload],
  );

  const mute = useCallback(
    async (item: Item, confirmed = false): Promise<Confirm | null> => {
      const res = await fetch("/api/items/mutes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ detector: item.detector, match: item.customer ?? item.phone, confirmed }),
      });
      if (res.status === 409) return ((await res.json()) as { confirm: Confirm }).confirm;
      await reload();
      return null;
    },
    [reload],
  );

  const reorder = useCallback(
    async (keys: string[]) => {
      await fetch("/api/items/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys }),
      });
      await reload();
    },
    [reload],
  );

  const say = useCallback((msg: string, undo?: () => Promise<void>) => {
    setToast({ msg, undo });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 6000);
  }, []);

  const api = useMemo(
    () => ({ view, error, reload, act, mute, reorder, toast, say, open, setOpen }),
    [view, error, reload, act, mute, reorder, toast, say, open],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useItems(): ItemsApi {
  const api = useContext(Ctx);
  if (!api) throw new Error("useItems outside ItemsProvider");
  return api;
}

/** The mockup has no Inbox area: customer threads and solicitations sit under Sales. */
export const RAIL_AREA: Record<Area, Exclude<Area, "inbox">> = {
  sales: "sales",
  inbox: "sales",
  jobs: "jobs",
  money: "money",
  marketing: "marketing",
  admin: "admin",
  system: "system",
};

export const AREA_LABEL: Record<Exclude<Area, "inbox">, string> = {
  sales: "Sales",
  jobs: "Jobs",
  money: "Money",
  marketing: "Marketing",
  admin: "Admin",
  system: "System",
};

/** Plain names for detector ids (the mockup's kind tag). */
export const KIND: Record<string, string> = {
  D1: "Done, not invoiced",
  D2: "Invoice not sent",
  D3: "Overdue invoice",
  D4: "Accepted, not scheduled",
  D5: "Stale quote",
  D9: "Assessment, no quote",
  D10: "Stub review",
  D11: "Incomplete event",
  D12: "Email awaiting reply",
  D13: "Hold",
  D14: "Booked, not on calendar",
  D15: "Worker health",
  L1: "Text thread",
  L2: "Email thread",
  T4: "Scope change",
  TODO: "Your to-do",
};
