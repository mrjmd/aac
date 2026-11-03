import { loadItemsView } from "@/lib/items";
import { Drawer, ToastHost } from "./components/items";
import { SignOut } from "./sign-out";
import { ItemsProvider } from "./items-context";
import { Rail } from "./rail";

// Items are per-request state; never prerender the shell.
export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const initial = await loadItemsView().catch(() => null);
  return (
    <ItemsProvider initial={initial}>
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
    </ItemsProvider>
  );
}
