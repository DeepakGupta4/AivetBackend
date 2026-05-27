import rateLimit from 'express-rate-limit';

// General API rate limiter
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1500, // generous: the dashboard polls audit/run progress frequently
  message: {
    success: false,
    message: 'Too many requests from this IP, please try again later.',
    code: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: 'Too many requests from this IP, please try again later.',
      code: 'RATE_LIMIT_EXCEEDED',
      retryAfter: Math.round(req.rateLimit.resetTime / 1000)
    });
  }
});

// Strict rate limiter for auth endpoints
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 auth requests per windowMs
  message: {
    success: false,
    message: 'Too many authentication attempts, please try again later.',
    code: 'AUTH_RATE_LIMIT_EXCEEDED'
  },
  skipSuccessfulRequests: true, // Don't count successful requests
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: 'Too many authentication attempts, please try again later.',
      code: 'AUTH_RATE_LIMIT_EXCEEDED',
      retryAfter: Math.round(req.rateLimit.resetTime / 1000)
    });
  }
});

// Campaign/prompt creation limiter
export const campaignLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // limit each IP to 20 campaign operations per hour
  message: {
    success: false,
    message: 'Too many campaign operations, please try again later.',
    code: 'CAMPAIGN_RATE_LIMIT_EXCEEDED'
  }
});

// Project operations limiter — split read vs write.
// Reads (GETs) need a generous cap because dashboards / visibility pages fire
// many calls per render (multiple widgets each hitting /projects/:id/...).
// Mutations (POST/PUT/DELETE) keep the strict cap to deter spam / abuse.
export const projectLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 600,                  // reads: ~10/min sustained — covers normal browsing
  skip: (req) => false,
  // Apply a much smaller cap for mutations via a second limiter (mounted by
  // the route file). Keep this one for all requests as the generous baseline.
  message: {
    success: false,
    message: 'Too many project operations, please try again later.',
    code: 'PROJECT_RATE_LIMIT_EXCEEDED'
  }
});

// Stricter limiter for project MUTATIONS (create/update/delete/run audit).
// Mount with router.post(...) etc instead of router.use().
export const projectMutationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 60,                   // 1 mutation per minute average
  message: {
    success: false,
    message: 'Too many project changes, please wait a moment and try again.',
    code: 'PROJECT_MUTATION_RATE_LIMIT_EXCEEDED'
  }
});

// Webhook limiter (more permissive for external services)
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // limit each IP to 100 webhook requests per minute
  message: {
    success: false,
    message: 'Webhook rate limit exceeded.',
    code: 'WEBHOOK_RATE_LIMIT_EXCEEDED'
  }
});

// Create custom rate limiter
export const createCustomLimiter = (options = {}) => {
  const defaults = {
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: {
      success: false,
      message: 'Rate limit exceeded, please try again later.',
      code: 'RATE_LIMIT_EXCEEDED'
    }
  };

  return rateLimit({ ...defaults, ...options });
};