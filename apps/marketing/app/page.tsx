import { redirect } from "next/navigation";
import { verifySession } from "@/lib/auth";

export default async function Home() {
  const authenticated = await verifySession();
  if (!authenticated) redirect("/login");

  return (
    <main className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <h1 className="font-display text-3xl font-bold text-aac-dark">
          Marketing Engine
        </h1>
        <p className="mt-2 text-zinc-400">
          Content production & campaign management
        </p>
      </div>
    </main>
  );
}
