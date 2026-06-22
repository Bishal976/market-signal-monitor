// Last updated: 2026-06-22 — one-shot entry point; scheduling now lives in GitHub Actions cron, not node-cron
import dotenv from "dotenv";
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

async function runMainCycle(): Promise<void> {
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

/** CLI entry point: `main` (default) runs the Reddit+HN scan cycle; `hn-hiring` checks the daily Who's Hiring thread. */
async function run(): Promise<void> {
  const mode = process.argv[2] ?? "main";

  if (mode === "hn-hiring") {
    resetAiCycleState();
    await searchHNHiringThread();
  } else {
    await runMainCycle();
  }
}

run();
