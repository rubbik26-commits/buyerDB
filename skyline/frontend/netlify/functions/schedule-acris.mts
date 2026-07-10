import type { Config } from "@netlify/functions";
import { triggerScheduled } from "../lib/schedule.mts";
export default async () => { await triggerScheduled("acris_refresh", { days: 120, limit: 750 }); };
export const config: Config = { schedule: "17 13 * * *" };
