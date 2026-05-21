import { z } from 'zod';

// User validation schemas
export const userSchemas = {
  register: z.object({
    email: z.string().email('Invalid email format').toLowerCase(),
    fullName: z.string().min(1, 'Full name is required').max(100, 'Full name too long'),
    password: z.string().min(8, 'Password must be at least 8 characters').optional(),
  }),

  login: z.object({
    email: z.string().email('Invalid email format').toLowerCase(),
    password: z.string().min(1, 'Password is required').optional(),
  }),

  updateProfile: z.object({
    fullName: z.string().min(1, 'Full name is required').max(100, 'Full name too long').optional(),
    avatarUrl: z.string().url('Invalid avatar URL').optional(),
  }),
};

// Team validation schemas
export const teamSchemas = {
  create: z.object({
    name: z.string().min(1, 'Team name is required').max(50, 'Team name too long'),
    slug: z.string().min(1, 'Team slug is required').max(30, 'Team slug too long')
      .regex(/^[a-z0-9-]+$/, 'Slug can only contain lowercase letters, numbers, and hyphens'),
  }),

  update: z.object({
    name: z.string().min(1, 'Team name is required').max(50, 'Team name too long').optional(),
  }),

  addMember: z.object({
    email: z.string().email('Invalid email format').toLowerCase(),
    role: z.enum(['admin', 'member'], 'Invalid role'),
  }),
};

// Accept a full URL ("https://www.flipkart.com/") OR a bare domain and
// normalize it to "flipkart.com" before validating — users paste either.
const domainField = z.preprocess(
  (v) => typeof v === 'string'
    ? v.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')
    : v,
  z.string().min(1, 'Domain is required')
    .regex(/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9](?:\.[a-z]{2,})+$/, 'Invalid domain format'),
);

// Project validation schemas
export const projectSchemas = {
  create: z.object({
    name: z.string().min(1, 'Project name is required').max(100, 'Project name too long'),
    domain: domainField,
    brandName: z.string().min(1, 'Brand name is required').max(50, 'Brand name too long'),
    industry: z.string().max(50, 'Industry name too long').optional(),
    targetRegion: z.string().max(50, 'Target region too long').optional(),
    // Domain optional — the UI allows adding a competitor by name only; the
    // route filters out empty entries.
    competitors: z.array(z.object({
      domain: z.string().max(253).optional(),
      brandName: z.string().max(50, 'Brand name too long').optional(),
    })).max(10, 'Maximum 10 competitors allowed').optional(),
  }),

  update: z.object({
    name: z.string().min(1, 'Project name is required').max(100, 'Project name too long').optional(),
    domain: domainField.optional(),
    brandName: z.string().min(1, 'Brand name is required').max(50, 'Brand name too long').optional(),
    industry: z.string().max(50, 'Industry name too long').optional(),
    targetRegion: z.string().max(50, 'Target region too long').optional(),
    isActive: z.boolean().optional(),
  }),

  addCompetitor: z.object({
    domain: z.string().min(1, 'Competitor domain is required'),
    brandName: z.string().min(1, 'Competitor brand name is required').max(50, 'Brand name too long'),
  }),
};

// Campaign validation schemas
export const campaignSchemas = {
  create: z.object({
    name: z.string().min(1, 'Campaign name is required').max(100, 'Campaign name too long'),
    description: z.string().max(500, 'Description too long').optional(),
    frequency: z.enum(['hourly', 'daily', 'weekly'], 'Invalid frequency'),
    prompts: z.array(z.object({
      text: z.string().min(1, 'Prompt text is required').max(500, 'Prompt text too long'),
      category: z.string().max(50, 'Category too long').optional(),
      intent: z.string().max(50, 'Intent too long').optional(),
    })).min(1, 'At least one prompt is required').max(50, 'Maximum 50 prompts allowed'),
  }),

  update: z.object({
    name: z.string().min(1, 'Campaign name is required').max(100, 'Campaign name too long').optional(),
    description: z.string().max(500, 'Description too long').optional(),
    frequency: z.enum(['hourly', 'daily', 'weekly'], 'Invalid frequency').optional(),
    isActive: z.boolean().optional(),
  }),

  addPrompt: z.object({
    text: z.string().min(1, 'Prompt text is required').max(500, 'Prompt text too long'),
    category: z.string().max(50, 'Category too long').optional(),
    intent: z.string().max(50, 'Intent too long').optional(),
  }),
};

// Query parameter validation schemas
export const querySchemas = {
  pagination: z.object({
    page: z.string().regex(/^\d+$/, 'Page must be a number').transform(Number).refine(n => n > 0, 'Page must be positive').optional(),
    limit: z.string().regex(/^\d+$/, 'Limit must be a number').transform(Number).refine(n => n > 0 && n <= 100, 'Limit must be between 1 and 100').optional(),
  }),

  dateRange: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format (YYYY-MM-DD)').optional(),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format (YYYY-MM-DD)').optional(),
  }),

  search: z.object({
    q: z.string().max(100, 'Search query too long').optional(),
    sort: z.enum(['asc', 'desc'], 'Invalid sort order').optional(),
    sortBy: z.string().max(50, 'Sort field too long').optional(),
  }),
};

// Validation middleware factory
export const validate = (schema, source = 'body') => {
  return (req, res, next) => {
    try {
      const data = source === 'query' ? req.query : 
                   source === 'params' ? req.params : 
                   req.body;

      const result = schema.safeParse(data);
      
      if (!result.success) {
        const errors = result.error.errors.map(err => ({
          field: err.path.join('.'),
          message: err.message,
        }));

        return res.status(400).json({
          success: false,
          message: 'Validation failed',
          code: 'VALIDATION_ERROR',
          errors,
        });
      }

      // Replace the original data with validated data
      if (source === 'query') req.query = result.data;
      else if (source === 'params') req.params = result.data;
      else req.body = result.data;

      next();
    } catch (error) {
      next(error);
    }
  };
};

// MongoDB ObjectId validation
export const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid ObjectId format');

export const validateObjectId = (paramName = 'id') => {
  return validate(z.object({
    [paramName]: objectIdSchema,
  }), 'params');
};