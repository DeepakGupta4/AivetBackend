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

// PLAN_LIMITS — promptLimit is the monthly credit/prompt cap, projectLimit is
// domains, competitorLimit is competitors trackable per brand. "free" is the
// Ubersuggest-style preview: any new user can sign up and add 1 brand with
// capped credits before paying. "pro" is the internal id for the publicly-
// named "Business" tier.
export const PLAN_LIMITS = {
  free:       { promptLimit: 50,    projectLimit: 1,  competitorLimit: 3  },
  starter:    { promptLimit: 250,   projectLimit: 1,  competitorLimit: 5  },
  pro:        { promptLimit: 500,   projectLimit: 7,  competitorLimit: 10 },
  enterprise: { promptLimit: 1000,  projectLimit: 15, competitorLimit: 15 },
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
