import nodemailer from "nodemailer";

// Accept both the generic SMTP_* names and the Gmail GMAIL_* names that
// dt-backend / the existing .env use, so credentials work without renaming.
const SMTP_USER = process.env.SMTP_USER ?? process.env.GMAIL_ACCOUNT;
const SMTP_PASS = process.env.SMTP_PASS ?? process.env.GMAIL_APP_PASSWORD;

let cachedTransporter = null;

function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  cachedTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return cachedTransporter;
}

// Resend HTTP API — a single HTTPS call, no SMTP handshake. This is instant and
// reliable on serverless (Vercel), where raw SMTP is slow/flaky.
async function sendViaResend({ to, subject, html, text }) {
  const from = process.env.RESEND_FROM ?? process.env.SMTP_FROM ?? "AIVet <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, html, text }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Resend ${res.status}: ${body?.message || JSON.stringify(body)}`);
  }
  return { messageId: body?.id };
}

export async function sendEmail({ to, subject, html, text }) {
  // Prefer Resend when configured (best for serverless). Fall back to SMTP.
  if (process.env.RESEND_API_KEY) {
    return sendViaResend({ to, subject, html, text });
  }
  if (!SMTP_USER) {
    console.warn("[email] No RESEND_API_KEY and no SMTP configured — logging email instead:");
    console.warn({ to, subject, text: text ?? html?.slice(0, 200) });
    return { skipped: true };
  }
  const from = process.env.SMTP_FROM ?? `AIVet <${SMTP_USER}>`;
  const info = await getTransporter().sendMail({ from, to, subject, html, text });
  return { messageId: info.messageId };
}

// Magic-link sign-in email — replicates the exact template dt-backend/dixor
// send (AIVET by Digirocket, lime CTA, "paste this link" fallback).
function buildMagicLinkEmailHtml(link, ttlMin) {
  return `<!doctype html>
<html><body style="font-family:Arial,sans-serif;background:#fafafa;padding:0;margin:0;">
  <div style="max-width:560px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e8e8e8;">
    <div style="background:#0d0d0d;padding:24px;color:#fff;">
      <div style="font-size:13px;letter-spacing:1px;color:#C9F31D;text-transform:uppercase;font-weight:700;">AIVET by Digirocket</div>
      <h1 style="margin:6px 0 0;font-size:22px;color:#fff;">Sign in to AIVET</h1>
    </div>
    <div style="padding:28px;">
      <p style="font-size:15px;color:#333;margin-top:0;">Click the button below to sign in to your AIVET dashboard. This link expires in ${ttlMin} minutes and can only be used once.</p>
      <div style="text-align:center;margin:28px 0;">
        <a href="${link}" style="background:#C9F31D;color:#000;padding:14px 32px;border-radius:999px;text-decoration:none;font-weight:700;display:inline-block;">Sign in to AIVET</a>
      </div>
      <p style="font-size:13px;color:#666;margin-bottom:6px;">Or paste this link into your browser:</p>
      <p style="font-size:12px;color:#999;word-break:break-all;background:#f7f7f7;padding:12px;border-radius:8px;">${link}</p>
      <p style="font-size:12px;color:#999;margin-top:24px;">If you didn't request this email, you can safely ignore it — no account changes were made.</p>
    </div>
    <div style="background:#f7f7f7;padding:16px;text-align:center;color:#999;font-size:12px;">AIVET — AI Visibility Enhancement Tool by Digirocket.</div>
  </div>
</body></html>`;
}

export async function sendMagicLinkEmail(email, magicUrl, ttlMin = 15) {
  return sendEmail({
    to: email,
    subject: "Sign in to AIVET",
    html: buildMagicLinkEmailHtml(magicUrl, ttlMin),
    text: `Sign in to AIVET: ${magicUrl}\n\nThis link expires in ${ttlMin} minutes and can only be used once.\n\nIf you didn't request this email, you can safely ignore it.`,
  });
}

export async function sendAlertEmail(email, { projectName, scoreChange, currentScore }) {
  const direction = scoreChange >= 0 ? "up" : "down";
  const arrow = scoreChange >= 0 ? "↑" : "↓";
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:32px;">
      <h2>Visibility alert: ${projectName}</h2>
      <p>Your AI visibility score has moved <strong>${direction}</strong>.</p>
      <p style="font-size:24px;"><strong>${currentScore}</strong> ${arrow} ${Math.abs(scoreChange).toFixed(1)}</p>
    </div>
  `;
  return sendEmail({ to: email, subject: `AIVet alert: ${projectName} score ${direction}`, html });
}
