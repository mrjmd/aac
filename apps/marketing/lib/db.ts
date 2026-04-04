import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import * as schema from "@/db/schema";

function getClient() {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");

  return createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}

export const db = drizzle(getClient(), { schema });
