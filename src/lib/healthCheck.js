import mongoose from 'mongoose';
import v8 from 'node:v8';
import logger from './logger.js';

// Health check status
let healthStatus = {
  status: 'healthy',
  timestamp: new Date().toISOString(),
  uptime: process.uptime(),
  version: process.env.npm_package_version || '1.0.0',
  environment: process.env.NODE_ENV || 'development',
  checks: {
    database: { status: 'unknown', message: '', responseTime: 0 },
    memory: { status: 'unknown', usage: 0, limit: 0 },
    disk: { status: 'unknown', usage: 0 },
  }
};

// Database health check
async function checkDatabase() {
  const start = Date.now();
  try {
    if (mongoose.connection.readyState !== 1) {
      throw new Error('Database not connected');
    }
    
    // Simple ping to database
    await mongoose.connection.db.admin().ping();
    
    const responseTime = Date.now() - start;
    
    return {
      status: responseTime < 3000 ? 'healthy' : 'degraded',
      message: responseTime < 3000 ? 'Database responding normally' : 'Database responding slowly',
      responseTime,
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      message: error.message,
      responseTime: Date.now() - start,
    };
  }
}

// Memory health check.
// NOTE: heapUsed/heapTotal is ALWAYS ~90%+ (V8 keeps its committed heap tight),
// so it falsely reports "unhealthy". The real "are we near OOM" signal is
// heapUsed vs the V8 heap_size_limit (the ceiling, ~2-4GB by default).
function checkMemory() {
  const mem = process.memoryUsage();
  const heapLimit = v8.getHeapStatistics().heap_size_limit || 2 * 1024 * 1024 * 1024;
  const pct = (mem.heapUsed / heapLimit) * 100;

  let status = 'healthy';
  let message = 'Memory usage normal';
  if (pct > 90) {
    status = 'unhealthy';
    message = 'Heap usage near limit';
  } else if (pct > 75) {
    status = 'degraded';
    message = 'Elevated heap usage';
  }

  return {
    status,
    message,
    usage: Math.round(pct),
    usedMB: Math.round(mem.rss / 1024 / 1024),
    heapMB: Math.round(mem.heapUsed / 1024 / 1024),
    limitMB: Math.round(heapLimit / 1024 / 1024),
  };
}

// Disk health check (simplified)
function checkDisk() {
  // In a real implementation, you'd check actual disk usage
  // For now, we'll just return a healthy status
  return {
    status: 'healthy',
    message: 'Disk usage normal',
    usage: 0, // Would be actual percentage
  };
}

// Run all health checks
export async function runHealthChecks() {
  const start = Date.now();
  
  try {
    const [database, memory, disk] = await Promise.all([
      checkDatabase(),
      Promise.resolve(checkMemory()),
      Promise.resolve(checkDisk()),
    ]);
    
    // Determine overall status
    const checks = { database, memory, disk };
    const hasUnhealthy = Object.values(checks).some(check => check.status === 'unhealthy');
    const hasDegraded = Object.values(checks).some(check => check.status === 'degraded');
    
    let overallStatus = 'healthy';
    if (hasUnhealthy) {
      overallStatus = 'unhealthy';
    } else if (hasDegraded) {
      overallStatus = 'degraded';
    }
    
    healthStatus = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      version: process.env.npm_package_version || '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      responseTime: Date.now() - start,
      checks,
    };
    
    // Log health status changes
    if (overallStatus !== 'healthy') {
      logger.warn('Health check failed', { status: overallStatus, checks });
    }
    
    return healthStatus;
  } catch (error) {
    logger.error('Health check error', error);
    
    healthStatus = {
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      version: process.env.npm_package_version || '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      responseTime: Date.now() - start,
      error: error.message,
      checks: {
        database: { status: 'unknown', message: 'Health check failed', responseTime: 0 },
        memory: { status: 'unknown', usage: 0, limit: 0 },
        disk: { status: 'unknown', usage: 0 },
      }
    };
    
    return healthStatus;
  }
}

// Get current health status (cached)
export function getHealthStatus() {
  return healthStatus;
}

// Health check middleware
export function healthCheckMiddleware(req, res) {
  const status = getHealthStatus();
  const httpStatus = status.status === 'healthy' ? 200 : 
                    status.status === 'degraded' ? 200 : 503;
  
  res.status(httpStatus).json(status);
}

// Detailed health check middleware (runs fresh checks)
export async function detailedHealthCheckMiddleware(req, res) {
  const status = await runHealthChecks();
  const httpStatus = status.status === 'healthy' ? 200 : 
                    status.status === 'degraded' ? 200 : 503;
  
  res.status(httpStatus).json(status);
}

// Readiness check (for Kubernetes/Docker)
export async function readinessCheck(req, res) {
  try {
    // Check if database is connected
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        status: 'not_ready',
        message: 'Database not connected',
      });
    }
    
    res.status(200).json({
      status: 'ready',
      message: 'Service is ready to accept traffic',
    });
  } catch (error) {
    res.status(503).json({
      status: 'not_ready',
      message: error.message,
    });
  }
}

// Liveness check (for Kubernetes/Docker)
export function livenessCheck(req, res) {
  res.status(200).json({
    status: 'alive',
    message: 'Service is alive',
    uptime: Math.round(process.uptime()),
  });
}

// Start periodic health checks
export function startHealthMonitoring(intervalMs = 60000) {
  // Run initial health check
  runHealthChecks().catch((e) => logger.error('Health check init failed', e));

  // Set up periodic health checks (never let a rejection escape)
  const interval = setInterval(() => {
    runHealthChecks().catch((e) => logger.error('Health check failed', e));
  }, intervalMs);
  
  // Cleanup on process exit
  process.on('SIGTERM', () => {
    clearInterval(interval);
  });
  
  process.on('SIGINT', () => {
    clearInterval(interval);
  });
  
  logger.info('Health monitoring started', { intervalMs });
  
  return interval;
}