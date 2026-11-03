import { loadItemsView } from "@/lib/items";
import { getPeopleStore } from "@/lib/people";
import { Drawer, ToastHost } from "./components/items";
import { SignOut } from "./sign-out";
import { ItemsProvider } from "./items-context";
import { PeopleProvider } from "./people-context";
import { Rail } from "./rail";

// Items are per-request state; never prerender the shell.
export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [initial, people] = await Promise.all([
    loadItemsView().catch(() => null),
    getPeopleStore()
      .list()
      .catch(() => []),
  ]);
  return (
    <ItemsProvider initial={initial}>
      <PeopleProvider initial={people}>
      <header className="top">
        <div className="brand">
          <span className="mark">AAC</span>
          <div>
            <div className="name">Command Center</div>
            <div className="tagline">Attack A Crack</div>
          </div>
        </div>
        <span className="spacer" />
        <SignOut />
      </header>
      <div className="shell">
        <Rail />
        <main>
          <div className="wrap">{children}</div>
        </main>
      </div>
      <Drawer />
      <ToastHost />
      </PeopleProvider>
    </ItemsProvider>
  );
}
