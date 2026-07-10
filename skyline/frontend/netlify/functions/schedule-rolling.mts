import type { Config } from "@netlify/functions";
import { triggerScheduled } from "../lib/schedule.mts";
export default async () => { await triggerScheduled("rolling_sales", { limit: 400 }); };
export const config: Config = { schedule: "27 14 * * *" };
