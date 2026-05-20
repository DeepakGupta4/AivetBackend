# AIVet Backend

Node.js + Express + MongoDB + JWT + Stripe + multi-LLM REST clients + Nodemailer + QStash + Puppeteer PDFs, deployable on Vercel.

## Setup

```bash
cd backend
npm install
cp .env.example .env   # fill in keys
npm run dev            # starts on http://localhost:8000 with hot reload
```

`RUN_LOCAL=1` (set in `.env`) makes background jobs run inline instead of via QStash — useful for local dev.

## Tech stack

| Layer        | Library |
| ------------ | ------- |
| Runtime      | Node.js (ES modules), Express 5 |
| DB / ODM     | MongoDB Atlas + Mongoose 8 |
| Auth         | JWT (`jsonwebtoken`) + magic-link via Nodemailer |
| Billing      | Stripe |
| AI engines   | OpenAI, Anthropic, Gemini, Perplexity, DataForSEO (Google AI Overviews) — pure REST |
| Jobs         | Upstash QStash (prod), inline workers (local) |
| PDF export   | `puppeteer-core` + `@sparticuz/chromium` |
| Email        | Nodemailer (Gmail SMTP) |
| Hosting      | Vercel serverless (entry: `api/index.js`) |

## API surface

```
GET    /health
GET    /

# Auth
POST   /api/auth/register                { email, password, fullName }
POST   /api/auth/login                   { email, password }
POST   /api/auth/magic-link/send         { email, fullName? }
POST   /api/auth/magic-link/verify       { token, email, fullName? }
GET    /api/auth/me                      Authorization: Bearer <jwt>

# Projects
GET    /api/projects
POST   /api/projects                     { name, domain, brandName, industry?, targetRegion? }
PUT    /api/projects/:id
DELETE /api/projects/:id
POST   /api/projects/:id/competitors     { domain, brandName }
GET    /api/projects/:id/competitors

# Visibility / dashboard
GET    /api/projects/:projectId/dashboard?days=30
GET    /api/projects/:projectId/scores/latest

# Campaigns
GET    /api/campaigns?projectId=...
POST   /api/campaigns                    { projectId, name, frequency, prompts }
PUT    /api/campaigns/:id
DELETE /api/campaigns/:id
POST   /api/campaigns/:id/run            queues via QStash (or inline locally)
GET    /api/campaigns/:id/runs

# Billing (Stripe)
POST   /api/billing/checkout             { plan: "starter"|"pro"|"enterprise" }
POST   /api/billing/portal
GET    /api/billing/subscription

# Reports
GET    /api/reports/projects/:id/pdf     downloads a PDF

# Webhooks (no auth — signed)
POST   /api/webhooks/stripe              raw body, Stripe-Signature
POST   /api/webhooks/run-campaign        QStash-signed
POST   /api/webhooks/calculate-score     QStash-signed
```

## Project layout

```
backend/
  api/index.js              # Vercel serverless entry → re-exports src/index.js
  src/
    index.js                # Express app + route registration
    lib/
      db.js                 # Mongoose connection (cached for serverless)
      email.js              # Nodemailer (magic links, alerts)
      stripe.js             # Stripe SDK + plan ↔ price mapping
      qstash.js             # QStash publish + verify
      pdf.js                # Puppeteer headless Chromium
      aiClients.js          # OpenAI / Claude / Gemini / Perplexity / DataForSEO
    middleware/auth.js      # requireAuth + signToken
    models/index.js         # User, Team, MagicLinkToken, Project, Campaign,
                            #   PromptRun, VisibilityScore, Subscription, AuditLog
    routes/
      auth.js               # password + magic-link auth
      projects.js
      campaigns.js
      visibility.js
      billing.js
      reports.js
      webhooks.js           # Stripe + QStash receivers
    services/
      visibilityCalculator.js
    workers/
      campaignRunner.js     # fans out a campaign across all engines
      scoreCalculator.js    # recomputes today's visibility score
  vercel.json
  .env.example
```

## Notes

- **Stripe webhook** needs raw body. The `/api/webhooks` mount runs *before* `express.json()`, and the route applies `express.raw()` itself.
- **DB caching**: `connectDB()` stashes the Mongoose connection on `globalThis` so warm Vercel invocations reuse it.
- **Magic links**: tokens are SHA-256 hashed at rest and have a TTL index (Mongo expires them automatically).
- **Local dev without QStash**: set `RUN_LOCAL=1` — `publishJob()` runs the worker inline.
- **Vercel Chromium**: `@sparticuz/chromium` ships a Vercel-compatible binary; locally we fall back to `PUPPETEER_EXECUTABLE_PATH` or system Chrome.
