import type { Config } from "@netlify/functions";
import { triggerScheduled } from "../lib/schedule.mts";
export default async () => { await triggerScheduled("crexi_refresh", { limit: 2500 }); };
export const config: Config = { schedule: "17 15 * * *" };
