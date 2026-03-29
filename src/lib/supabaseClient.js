import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  // eslint-disable-next-line no-console
  console.warn("Supabase env vars are missing. Set VITE_SUPABASE_URL and VITE_SUPABASE_KEY.");
}

export const supabase = createClient(supabaseUrl || "https://placeholder.invalid", supabaseKey || "placeholder-key");
