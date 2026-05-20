import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import compression from "compression";
import timeout from "express-timeout-handler";

import { connectDB } from "./lib/db.js";
import { validateEnvironment } from "./lib/envValidator.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { apiLimiter } from "./middleware/rateLimiter.js";
import logger, { requestLogger } from "./lib/logger.js";
import { healthCheckMiddleware, detailedHealthCheckMiddleware, readinessCheck, livenessCheck, startHealthMonitoring } from "./lib/healthCheck.js";
import authRoutes       from "./routes/auth.js";
import projectRoutes    from "./routes/projects.js";
import campaignRoutes   from "./routes/campaigns.js";
import visibilityRoutes from "./routes/visibility.js";
import billingRoutes    from "./routes/billing.js";
import reportRoutes     from "./routes/reports.js";
import teamRoutes       from "./routes/team.js";
import webhookRoutes    from "./routes/webhooks.js";
import faviconRoutes    from "./routes/favicon.js";

// Safety net: log stray errors with their stack instead of letting a single
// unhandled rejection take down the whole dev server.
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { reason: reason instanceof Error ? reason.stack : String(reason) });
});
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", { error: err?.stack || String(err) });
});

// Validate environment variables at startup
validateEnvironment();

const app  = express();
const PORT = process.env.PORT ?? 8000;

// Behind Vercel's proxy — needed so req.ip / rate-limiter read X-Forwarded-For
// correctly (otherwise express-rate-limit throws ERR_ERL_FORWARDED_HEADER).
app.set("trust proxy", 1);

// ── Security & logging ────────────────────────────────────────────────────
app.use(helmet());

// Performance optimizations
app.use(compression({
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
  threshold: 1024, // Only compress responses > 1KB
}));

// Request timeout (30 seconds)
app.use(timeout.handler({
  timeout: 30000,
  onTimeout: (req, res) => {
    logger.warn('Request timeout', {
      method: req.method,
      url: req.url,
      ip: req.ip,
    });
    res.status(408).json({
      success: false,
      message: 'Request timeout',
      code: 'REQUEST_TIMEOUT'
    });
  },
}));

// Rate limiting — production only. In dev the app polls heavily (live audit /
// campaign-run progress every few seconds), which the limiters would throttle.
if (process.env.NODE_ENV === "production") {
  app.use("/api/", apiLimiter);
}
// The deployed dashboard frontend is always allowed; add more via CORS_ORIGINS
// (comma-separated) without needing a code change.
const PROD_ORIGINS = ["https://aivet-frontend.vercel.app"];
const allowedOrigins = [
  ...(process.env.CORS_ORIGINS ?? process.env.FRONTEND_URL ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  ...PROD_ORIGINS,
];
// Always allow the local Next dev server outside production.
if (process.env.NODE_ENV !== "production") {
  allowedOrigins.push("http://localhost:3000", "http://127.0.0.1:3000");
}
// De-dupe.
const uniqueOrigins = [...new Set(allowedOrigins)];
app.use(cors({
  origin: uniqueOrigins.length ? uniqueOrigins : true,
  credentials: true,
}));
app.use(cookieParser());
app.use(morgan("dev"));
app.use(requestLogger);

// ── Webhooks MUST come before express.json() so the Stripe route can
//    receive a raw Buffer for signature verification. The route itself
//    applies express.raw() / express.json() per handler.
app.use("/api/webhooks", webhookRoutes);

// JSON body parser for the rest of the API
app.use(express.json({ limit: "1mb" }));

// ── App routes ────────────────────────────────────────────────────────────
app.use("/api/favicon",   faviconRoutes);   // public — brand logo proxy (no DB)

// On serverless, a request can hit a route before the cold-start DB connect has
// resolved → Mongoose buffers the query and fails with "buffering timed out".
// Await the (cached) connection here so DB routes never run unconnected.
app.use(async (_req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    logger.error("DB connection failed for request", { error: err?.message });
    res.status(503).json({ success: false, message: "Database unavailable, please try again." });
  }
});

app.use("/api/auth",      authRoutes);
app.use("/api/projects",  projectRoutes);
app.use("/api/projects",  visibilityRoutes);   // /api/projects/:id/dashboard
app.use("/api/campaigns", campaignRoutes);
app.use("/api/billing",   billingRoutes);
app.use("/api/reports",   reportRoutes);
app.use("/api/team",      teamRoutes);

// ── Health ────────────────────────────────────────────────────────────────
app.get("/health", healthCheckMiddleware);
app.get("/health/detailed", detailedHealthCheckMiddleware);
app.get("/health/ready", readinessCheck);
app.get("/health/live", livenessCheck);
app.get("/", (_, res) => res.json({ name: "AIVet API", version: "1.0.0", status: "running" }));

// ── 404 ───────────────────────────────────────────────────────────────────
app.use(notFoundHandler);

// ── Error handler ─────────────────────────────────────────────────────────
app.use(errorHandler);

// ── Bootstrap: connect DB then listen. On Vercel we export the handler. ──
const isVercel = !!process.env.VERCEL;

if (!isVercel) {
  connectDB()
    .then(() => {
      // Start health monitoring
      startHealthMonitoring(60000); // Check every minute
      
      app.listen(PORT, () => {
        logger.info(`🚀 AIVet API server started on port ${PORT}`);
        console.log(`🚀 AIVet API on http://localhost:${PORT}`);
      });
    })
    .catch((err) => { 
      logger.error('❌ DB connection failed:', err);
      console.error("❌ DB connection failed:", err.message); 
      process.exit(1); 
    });
} else {
  // On Vercel, ensure DB is connected once per cold start.
  connectDB().then(() => {
    startHealthMonitoring(300000); // Check every 5 minutes on serverless
  }).catch((err) => {
    logger.error('❌ DB connection failed:', err);
    console.error("❌ DB connection failed:", err.message);
  });
}

export default app;
