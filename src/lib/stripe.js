import Stripe from "stripe";

let cached = null;

export function getStripe() {
  if (cached) return cached;
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY not set");
  }
  cached = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
  return cached;
}

export const PLAN_LIMITS = {
  free:       { promptLimit: 100,    projectLimit: 1 },
  starter:    { promptLimit: 1000,   projectLimit: 3 },
  pro:        { promptLimit: 10000,  projectLimit: 10 },
  enterprise: { promptLimit: 100000, projectLimit: 50 },
};

// Support both STRIPE_PRICE_* and the project's STRIPE_PRICE_AIVET_* env names.
const PRICE_STARTER    = process.env.STRIPE_PRICE_STARTER    ?? process.env.STRIPE_PRICE_AIVET_STARTER;
const PRICE_PRO        = process.env.STRIPE_PRICE_PRO        ?? process.env.STRIPE_PRICE_AIVET_PROFESSIONAL;
const PRICE_ENTERPRISE = process.env.STRIPE_PRICE_ENTERPRISE ?? process.env.STRIPE_PRICE_AIVET_ENTERPRISE;

export function planFromPriceId(priceId) {
  if (priceId === PRICE_STARTER)    return "starter";
  if (priceId === PRICE_PRO)        return "pro";
  if (priceId === PRICE_ENTERPRISE) return "enterprise";
  return "free";
}

export function priceIdForPlan(plan) {
  return { starter: PRICE_STARTER, pro: PRICE_PRO, enterprise: PRICE_ENTERPRISE }[plan];
}
