// Environment validation utility
// Validates required environment variables at startup

const REQUIRED_ENVS = [
  { name: 'MONGODB_URI', description: 'MongoDB connection string' },
  // Auth secret can be any of these names (auth.js falls back through them).
  { names: ['JWT_SECRET', 'JWT_SECRET_KEY', 'AIVET_JWT_SECRET'], description: 'JWT signing secret (min 32 chars)', minLength: 32 },
  { name: 'FRONTEND_URL', description: 'Frontend URL for CORS' },
];

const OPTIONAL_ENVS = [
  { name: 'STRIPE_SECRET_KEY', description: 'Stripe secret key for payments' },
  { name: 'STRIPE_WEBHOOK_SECRET', description: 'Stripe webhook secret' },
  { name: 'GMAIL_ACCOUNT', description: 'Gmail account for magic-link email' },
  { name: 'GMAIL_APP_PASSWORD', description: 'Gmail app password' },
  { name: 'OPENAI_API_KEY', description: 'OpenAI API key for AI features' },
  { name: 'GEMINI_API_KEY', description: 'Google Gemini API key' },
  { name: 'ANTHROPIC_API_KEY', description: 'Anthropic Claude API key' },
  { name: 'DATAFORSEO_LOGIN', description: 'DataForSEO login (Google AI Overview + domain authority)' },
];

export function validateEnvironment() {
  const errors = [];
  const warnings = [];

  // Check required environment variables (supports alternative names)
  for (const env of REQUIRED_ENVS) {
    const names = env.names ?? [env.name];
    const value = names.map((n) => process.env[n]).find(Boolean);

    if (!value) {
      errors.push(`❌ ${names.join(' / ')} is required: ${env.description}`);
      continue;
    }

    if (env.minLength && value.length < env.minLength) {
      errors.push(`❌ ${names.join(' / ')} must be at least ${env.minLength} characters long`);
    }
  }

  // Check optional environment variables
  for (const env of OPTIONAL_ENVS) {
    const value = process.env[env.name];
    
    if (!value) {
      warnings.push(`⚠️  ${env.name} not set: ${env.description}`);
    }
  }

  // Log results
  if (errors.length > 0) {
    console.error('\n🚨 Environment Validation Failed:');
    errors.forEach(error => console.error(`  ${error}`));
    
    if (process.env.NODE_ENV === 'production') {
      console.error('\n💥 Exiting due to missing required environment variables in production');
      process.exit(1);
    } else {
      console.error('\n⚠️  Development mode: continuing with missing variables');
    }
  } else {
    console.log('✅ All required environment variables are set');
  }

  if (warnings.length > 0) {
    console.warn('\n⚠️  Optional environment variables not set:');
    warnings.forEach(warning => console.warn(`  ${warning}`));
  }

  return { errors, warnings };
}

// Validate specific environment variable
export function validateEnv(name, value, options = {}) {
  const { required = false, minLength = 0, pattern = null } = options;

  if (required && !value) {
    throw new Error(`Environment variable ${name} is required`);
  }

  if (value && minLength && value.length < minLength) {
    throw new Error(`Environment variable ${name} must be at least ${minLength} characters long`);
  }

  if (value && pattern && !pattern.test(value)) {
    throw new Error(`Environment variable ${name} does not match required pattern`);
  }

  return value;
}

// Get environment with validation
export function getEnv(name, defaultValue = null, options = {}) {
  const value = process.env[name] || defaultValue;
  return validateEnv(name, value, options);
}