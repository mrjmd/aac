import { Sidebar } from "./sidebar";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="min-w-0 flex-1 p-4 pt-16 sm:p-6 sm:pt-16 lg:p-8">{children}</main>
    </div>
  );
}
