import { supabase } from "./supabaseClient";

const TABLE = "app_storage";
const NAMESPACE = "medstudy";

export async function sGet(key) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("value")
    .eq("namespace", NAMESPACE)
    .eq("key", key)
    .maybeSingle();

  if (error) {
    console.error("sGet error:", error.message);
    return null;
  }

  return data?.value ?? null;
}

export async function sSet(key, value) {
  const payload = {
    namespace: NAMESPACE,
    key,
    value,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from(TABLE).upsert(payload, {
    onConflict: "namespace,key",
  });

  if (error) {
    console.error("sSet error:", error.message);
  }
}

export async function sDelete(key) {
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq("namespace", NAMESPACE)
    .eq("key", key);

  if (error) {
    console.error("sDelete error:", error.message);
  }
}

export async function sDeleteMany(keys) {
  if (!keys.length) return;
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq("namespace", NAMESPACE)
    .in("key", keys);

  if (error) {
    console.error("sDeleteMany error:", error.message);
  }
}
