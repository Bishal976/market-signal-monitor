// Last updated: 2026-06-14 — delayed initial HN hiring-thread run to avoid startup AI-cap race
import dotenv from "dotenv";
import cron from "node-cron";
import { runHnMonitor, searchHNHiringThread } from "./hn";
import { runRedditMonitor } from "./reddit";
import { resetAiCycleState, getCappedLeads } from "./ai-filter";
import { sendLeadsDigest } from "./mailer";
import { logDailySummary } from "./stats";

dotenv.config();

const REQUIRED_ENV_VARS = ["GMAIL_USER", "GMAIL_APP_PASSWORD", "GROQ_API_KEY"];
const missingEnvVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
if (missingEnvVars.length > 0) {
  console.error(`[STARTUP] Missing required env vars: ${missingEnvVars.join(", ")}`);
  process.exit(1);
}

async function main() {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Starting job alert monitoring cycle...`);

  resetAiCycleState();

  try {
    await runHnMonitor();
    await runRedditMonitor();

    const cappedLeads = getCappedLeads();
    if (cappedLeads.length > 0) {
      await sendLeadsDigest(cappedLeads);
    }
  } catch (error) {
    console.error("Monitor cycle error:", (error as Error).message);
  }

  logDailySummary();
  console.log(`[${timestamp}] Cycle complete.`);
}

// Run immediately on startup, then every 30 minutes.
// Reduced from 15min to avoid Reddit RSS rate limiting
main();
cron.schedule("*/30 * * * *", main);

// HN "Who is hiring" thread: initial run delayed, then daily at 10:00 AM.
// Delayed 2min to avoid consuming AI cap during main startup cycle
console.log("[HN-HIRING] Scheduled initial run in 2 minutes");
setTimeout(() => searchHNHiringThread(), 2 * 60 * 1000);
cron.schedule("0 10 * * *", searchHNHiringThread);
