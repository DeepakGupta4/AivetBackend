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

// Project operations limiter
export const projectLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50, // limit each IP to 50 project operations per hour
  message: {
    success: false,
    message: 'Too many project operations, please try again later.',
    code: 'PROJECT_RATE_LIMIT_EXCEEDED'
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