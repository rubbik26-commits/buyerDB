import type { Config } from "@netlify/functions";
import { triggerScheduled } from "../lib/schedule.mts";
export default async () => { await triggerScheduled("traded_refresh", { max_fetches: 50 }); };
export const config: Config = { schedule: "47 13 * * *" };
