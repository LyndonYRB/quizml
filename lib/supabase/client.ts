// lib/supabase/client.ts
import { createBrowserClient } from "@supabase/ssr";

/* =========================================================
   CONFIG
========================================================= */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/* =========================================================
   CLIENT FACTORY (Browser)
========================================================= */

export function createClient() {
  return createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}
