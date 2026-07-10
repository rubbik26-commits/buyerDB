import { getEnv } from "./supabase.mts";

export async function socrata(dataset: string, params: Record<string, string>) {
  const url = new URL(`https://data.cityofnewyork.us/resource/${dataset}.json`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const token = getEnv("SOCRATA_APP_TOKEN");
  const response = await fetch(url, {
    headers: { "User-Agent": "Skyline-Deal-Intelligence/1.0", ...(token ? { "X-App-Token": token } : {}) },
  });
  if (!response.ok) throw new Error(`${dataset} HTTP ${response.status}: ${(await response.text()).slice(0, 250)}`);
  return response.json();
}
