import type { Config } from "@netlify/functions";
import { triggerScheduled } from "../lib/schedule.mts";
export default async () => { await triggerScheduled("property_owner_refresh", { limit: 400, dos_limit: 400 }); };
export const config: Config = { schedule: "43 11 * * 0" };
