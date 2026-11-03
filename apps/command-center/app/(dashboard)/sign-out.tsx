"use client";

import { useRouter } from "next/navigation";

export function SignOut() {
  const router = useRouter();
  return (
    <button
      className="btn sm"
      type="button"
      onClick={async () => {
        await fetch("/auth/signout", { method: "POST" });
        router.push("/login");
      }}
    >
      Sign out
    </button>
  );
}
