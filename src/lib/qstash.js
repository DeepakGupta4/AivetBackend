import { Client, Receiver } from "@upstash/qstash";

let publisher = null;
let receiver  = null;

export function getQstashClient() {
  if (publisher) return publisher;
  if (!process.env.QSTASH_TOKEN) throw new Error("QSTASH_TOKEN not set");
  publisher = new Client({ token: process.env.QSTASH_TOKEN });
  return publisher;
}

export function getQstashReceiver() {
  if (receiver) return receiver;
  if (!process.env.QSTASH_CURRENT_SIGNING_KEY) throw new Error("QSTASH signing keys not set");
  receiver = new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey:    process.env.QSTASH_NEXT_SIGNING_KEY,
  });
  return receiver;
}

/**
 * Publish a job to QStash. If RUN_LOCAL=1, fall back to running inline.
 * @param {string} path - relative path like "/api/webhooks/run-campaign"
 * @param {object} body - JSON payload
 * @param {object} opts - { delay?: seconds, runLocal?: () => Promise }
 */
export async function publishJob(path, body, opts = {}) {
  if (process.env.RUN_LOCAL === "1" && typeof opts.runLocal === "function") {
    // Fire & forget inline
    Promise.resolve().then(opts.runLocal).catch((e) => console.error("[runLocal]", e));
    return { local: true };
  }
  const base = process.env.WEBHOOK_BASE_URL;
  if (!base) throw new Error("WEBHOOK_BASE_URL not set");
  const url = `${base.replace(/\/$/, "")}${path}`;
  const client = getQstashClient();
  return client.publishJSON({ url, body, delay: opts.delay });
}
