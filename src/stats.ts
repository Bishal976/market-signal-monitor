/** Daily funnel counters for [DAILY-SUMMARY] logging. Resets automatically when the date changes. */
interface DailyStats {
  date: string;
  scanned: number;
  keywordMatch: number;
  intentPass: number;
  aiScored: number;
  emailsSent: number;
}

function freshStats(): DailyStats {
  return {
    date: new Date().toISOString().slice(0, 10),
    scanned: 0,
    keywordMatch: 0,
    intentPass: 0,
    aiScored: 0,
    emailsSent: 0,
  };
}

let stats = freshStats();

function rolloverIfNewDay(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (stats.date !== today) stats = freshStats();
}

export function recordScanned(): void {
  rolloverIfNewDay();
  stats.scanned++;
}

export function recordKeywordMatch(): void {
  rolloverIfNewDay();
  stats.keywordMatch++;
}

export function recordIntentPass(): void {
  rolloverIfNewDay();
  stats.intentPass++;
}

export function recordAiScored(): void {
  rolloverIfNewDay();
  stats.aiScored++;
}

export function recordEmailSent(): void {
  rolloverIfNewDay();
  stats.emailsSent++;
}

export function logDailySummary(): void {
  rolloverIfNewDay();
  console.log(
    `[DAILY-SUMMARY] Scanned: ${stats.scanned} | Keyword match: ${stats.keywordMatch} | Intent filter pass: ${stats.intentPass} | AI scored: ${stats.aiScored} | Emails sent: ${stats.emailsSent}`
  );
}
