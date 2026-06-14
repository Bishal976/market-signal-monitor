// Last updated: 2026-06-14 — fallback email body now only uses fields that exist on JobPost
import nodemailer from "nodemailer";
import { JobPost } from "./types";
import { AiResult, CappedLead } from "./ai-filter";

let transporter: nodemailer.Transporter | null = null;

/** Created lazily so GMAIL_* env vars are read after dotenv.config() has run. */
function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });
  }
  return transporter;
}

/**
 * Sends a job alert email. SMTP/auth errors are caught and logged here rather than
 * thrown, so a misconfigured mailer can't surface as an error in the Reddit/HN
 * monitor that happened to find the match.
 */
export async function sendJobAlert(job: JobPost, aiResult?: AiResult): Promise<void> {
  let subject: string;
  let body: string;

  if (aiResult) {
    subject = `[LEAD ${aiResult.score}/10] ${job.title}`;
    body = [
      `POST LINK: ${job.url}`,
      ``,
      `AI SCORE: ${aiResult.score}/10`,
      ``,
      `WHY THIS FITS: ${aiResult.reasoning}`,
      ``,
      `DRAFTED RESPONSE (copy and send):`,
      aiResult.draftedResponse,
      ``,
      `ORIGINAL POST SNIPPET: ${job.detail ?? "N/A"}`,
    ].join("\n");
  } else {
    subject = `[LEAD - NO AI] ${job.title}`;
    body = [
      `SOURCE: ${job.source}`,
      `POST LINK: ${job.url}`,
      `POSTED: ${job.posted ?? "unknown"}`,
      `SNIPPET: ${job.detail ? job.detail.slice(0, 300) : "No preview available"}`,
    ].join("\n");
  }

  try {
    await getTransporter().sendMail({
      from: process.env.GMAIL_USER,
      to: process.env.GMAIL_USER,
      subject,
      text: body,
    });
  } catch (err) {
    console.error("[MAILER] SMTP connection failed:", (err as Error).message);
  }
}

/** Sends a single digest email listing leads that were skipped due to the per-cycle AI call cap. */
export async function sendLeadsDigest(leads: CappedLead[]): Promise<void> {
  const body = leads.map((lead) => `${lead.title}\n${lead.url}`).join("\n\n");

  try {
    await getTransporter().sendMail({
      from: process.env.GMAIL_USER,
      to: process.env.GMAIL_USER,
      subject: "[LEADS DIGEST - REVIEW MANUALLY]",
      text: body,
    });
  } catch (err) {
    console.error("[MAILER] SMTP connection failed:", (err as Error).message);
  }
}
