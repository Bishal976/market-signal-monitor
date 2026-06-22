// Last updated: 2026-06-14 — hardened Groq response parsing (markdown-fence stripping, shape validation)
import axios from "axios";
import { JobPost } from "./types";
import { DEBUG_FILTERING } from "./config";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export const MAX_AI_CALLS_PER_CYCLE = 5;

export interface CappedLead {
  title: string;
  url: string;
}

let aiCallCount = 0;
let cappedLeads: CappedLead[] = [];

/** Resets the per-cycle AI call counter and capped-leads list. Call once at the start of each cron cycle. */
export function resetAiCycleState(): void {
  aiCallCount = 0;
  cappedLeads = [];
}

/** True if another AI call can still be made within this cycle's cap. */
export function canMakeAiCall(): boolean {
  return aiCallCount < MAX_AI_CALLS_PER_CYCLE;
}

export function incrementAiCallCount(): void {
  aiCallCount++;
}

export function addCappedLead(lead: CappedLead): void {
  cappedLeads.push(lead);
}

export function getCappedLeads(): CappedLead[] {
  return cappedLeads;
}

const SYSTEM_PROMPT = `You are a lead qualification agent screening posts for Bishal Kumar. You are NOT Bishal — you are an assistant evaluating posts on his behalf. You must respond with ONLY a valid JSON object. No explanation, no markdown, no extra text.

PERSONA (for reference only — you are NOT this person): Bishal Kumar, Senior Frontend Developer, 3+ years experience in React, Next.js, TypeScript, and AI-integrated frontend tools. Builds fast production-quality frontends and small AI-powered SaaS tools for early-stage startups. Portfolio: bishal-portfolio-seven.vercel.app. Seeking freelance/contract/startup collaboration.

BUDGET GUIDANCE (soft signal, not a hard gate):
- International posts (USD): ideal $300+, reject only if explicitly below $100
- Domestic posts (INR): ideal ₹10k+, reject only if explicitly below ₹5k
- No budget mentioned: do NOT reject — score on tech fit only
- "Equity only" or "unpaid": always reject

GATE CHECK — return {"score": 0, "reasoning": "Gate check failed", "draftedResponse": ""} immediately if ANY of these are true:
- Author is advertising THEIR OWN services (they are the freelancer, not the client)
- Post is a project showcase / "I built X" with no request for external help
- Post is a weekly/monthly community thread or show-and-tell
- Explicitly unpaid, equity-only, or intern-level

BUYING INTENT SIGNALS — at least one must be present to pass the gate:
Strong: "hiring", "looking for developer", "need a developer", "need help with", "paid project", "contract", "freelance", "budget:", "rate:", "willing to pay", "MVP", "build this for me", "co-founder" (if they're non-technical and need a dev built)
Medium: "who can help", "anyone available", "open to paying"
If none of these signals are present anywhere in title or body, the gate fails — return {"score": 0, "reasoning": "Gate check failed", "draftedResponse": ""}.

TECH FIT SCORE 1-10 (only if gate passes):
- Primary: React/Next.js/TypeScript/AI frontend match
- Required: freelance/contract nature
- Bonus: budget in range, early-stage startup, solo founder

DRAFTED RESPONSE (only if score >= 6):
Write a 2-3 paragraph outreach reply. Engineer tone, no fluff. Reference one specific detail from the post. End with portfolio link.
If score < 6, return draftedResponse as empty string "".

Return format (always):
{"score": <number>, "reasoning": "<string>", "draftedResponse": "<string>"}`;

export interface AiResult {
  score: number;
  reasoning: string;
  draftedResponse: string;
}

/**
 * Scores a post for fit and drafts an outreach message if it's a strong match.
 * Returns null if the score is below 6 (caller should skip alerting on it).
 */
export async function analyzeAndDraft(post: JobPost): Promise<AiResult | null> {
  const userMessage = [
    `Source: ${post.source}`,
    `Title: ${post.title}`,
    `URL: ${post.url}`,
    `Detail/snippet: ${post.detail ?? "N/A"}`,
    `Posted: ${post.posted ?? "N/A"}`,
  ].join("\n");

  const res = await axios.post(
    GROQ_URL,
    {
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      response_format: { type: "json_object" },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );

  const text: string | undefined = res.data?.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error("Unexpected response shape from Groq API");
  }

  let parsed: AiResult;
  try {
    const raw = text.trim();
    const cleaned = raw
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    parsed = JSON.parse(cleaned) as AiResult;

    if (
      typeof parsed.score !== "number" ||
      typeof parsed.reasoning !== "string" ||
      typeof parsed.draftedResponse !== "string"
    ) {
      throw new Error("Invalid response shape");
    }
  } catch {
    console.error(`[AI-FILTER] JSON parse failed, raw response: ${text.slice(0, 200)}`);
    // Throw (not return null) so the caller's catch block falls back to a
    // plain "[LEAD - NO AI]" email instead of silently dropping the lead.
    throw new Error("Groq response was not valid JSON");
  }

  // Gated at >=4 to surface near-misses without flooding logs with zero-score noise
  if (DEBUG_FILTERING && parsed.score >= 4) {
    console.log(
      `[SCORE-RESULT] Score: ${parsed.score} | Email threshold: 6 | Will send: ${parsed.score >= 6} | Title: "${post.title}"`
    );
  }

  if (parsed.score < 6) return null;
  return parsed;
}
