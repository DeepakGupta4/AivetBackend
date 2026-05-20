import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';

// Custom log format
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;
    
    if (Object.keys(meta).length > 0) {
      log += ` | Meta: ${JSON.stringify(meta)}`;
    }
    
    if (stack) {
      log += `\nStack: ${stack}`;
    }
    
    return log;
  })
);

// Console format for development
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let log = `${timestamp} ${level}: ${message}`;
    
    if (Object.keys(meta).length > 0) {
      log += ` ${JSON.stringify(meta, null, 2)}`;
    }
    
    return log;
  })
);

// Serverless platforms (Vercel/Lambda) have a read-only filesystem, so writing
// rotating log files there throws on every log. Detect that and log to the
// console only — the platform captures stdout. File rotation is used only on
// long-lived servers (local dev / a VM).
const isServerless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const logsDir = path.join(process.cwd(), 'logs');

const transports = [
  new winston.transports.Console({
    // Plain JSON in production logs (machine-readable), pretty colours in dev.
    format: process.env.NODE_ENV === 'production' ? logFormat : consoleFormat,
  }),
];

if (!isServerless) {
  transports.push(
    new DailyRotateFile({
      filename: path.join(logsDir, 'application-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
      format: logFormat,
    }),
    new DailyRotateFile({
      filename: path.join(logsDir, 'error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxSize: '20m',
      maxFiles: '30d',
      format: logFormat,
    }),
  );
}

// Create logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  defaultMeta: {
    service: 'aivet-api',
    environment: process.env.NODE_ENV || 'development',
  },
  transports,
});

// Request logging middleware
export const requestLogger = (req, res, next) => {
  const start = Date.now();
  
  // Log request
  logger.info('Incoming request', {
    method: req.method,
    url: req.url,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    userId: req.user?.id,
  });

  // Override res.json to log response
  const originalJson = res.json;
  res.json = function(data) {
    const duration = Date.now() - start;
    
    logger.info('Request completed', {
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      userId: req.user?.id,
    });

    return originalJson.call(this, data);
  };

  next();
};

// Database operation logger
export const dbLogger = {
  query: (operation, collection, query = {}, duration = null) => {
    logger.debug('Database operation', {
      operation,
      collection,
      query: JSON.stringify(query),
      duration: duration ? `${duration}ms` : null,
    });
  },

  error: (operation, collection, error, query = {}) => {
    logger.error('Database error', {
      operation,
      collection,
      query: JSON.stringify(query),
      error: error.message,
      stack: error.stack,
    });
  },
};

// Security event logger
export const securityLogger = {
  authAttempt: (email, success, ip, userAgent) => {
    logger.info('Authentication attempt', {
      email,
      success,
      ip,
      userAgent,
      type: 'auth_attempt',
    });
  },

  authFailure: (email, reason, ip, userAgent) => {
    logger.warn('Authentication failure', {
      email,
      reason,
      ip,
      userAgent,
      type: 'auth_failure',
    });
  },

  rateLimitExceeded: (ip, endpoint, userAgent) => {
    logger.warn('Rate limit exceeded', {
      ip,
      endpoint,
      userAgent,
      type: 'rate_limit_exceeded',
    });
  },

  suspiciousActivity: (description, ip, userId, metadata = {}) => {
    logger.warn('Suspicious activity detected', {
      description,
      ip,
      userId,
      metadata,
      type: 'suspicious_activity',
    });
  },
};

// Business logic logger
export const businessLogger = {
  projectCreated: (projectId, userId, teamId) => {
    logger.info('Project created', {
      projectId,
      userId,
      teamId,
      type: 'project_created',
    });
  },

  campaignRun: (campaignId, projectId, status, duration = null) => {
    logger.info('Campaign run', {
      campaignId,
      projectId,
      status,
      duration: duration ? `${duration}ms` : null,
      type: 'campaign_run',
    });
  },

  visibilityScoreCalculated: (projectId, score, previousScore = null) => {
    logger.info('Visibility score calculated', {
      projectId,
      score,
      previousScore,
      change: previousScore ? score - previousScore : null,
      type: 'visibility_score_calculated',
    });
  },

  subscriptionChanged: (teamId, oldPlan, newPlan, userId) => {
    logger.info('Subscription changed', {
      teamId,
      oldPlan,
      newPlan,
      userId,
      type: 'subscription_changed',
    });
  },
};

// Performance logger
export const performanceLogger = {
  slowQuery: (operation, duration, query = {}) => {
    logger.warn('Slow database query detected', {
      operation,
      duration: `${duration}ms`,
      query: JSON.stringify(query),
      type: 'slow_query',
    });
  },

  apiResponse: (endpoint, method, duration, statusCode) => {
    const level = duration > 5000 ? 'warn' : 'info';
    logger.log(level, 'API response time', {
      endpoint,
      method,
      duration: `${duration}ms`,
      statusCode,
      type: 'api_response_time',
    });
  },
};

// Error logger with context
export const logError = (error, context = {}) => {
  logger.error('Application error', {
    message: error.message,
    stack: error.stack,
    name: error.name,
    code: error.code,
    ...context,
  });
};

// Export main logger
export default logger;