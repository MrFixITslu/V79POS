import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://redis:6379'),
  AUTH_MODE: z.enum(['hub', 'dev']).default('hub'),
  JWT_ISSUER: z.string().url().default('https://hub.v79sl.com'),
  JWT_AUDIENCE: z.string().default('v79-commerce'),
  HUB_JWKS_URL: z.string().url().default('https://hub.v79sl.com/.well-known/jwks.json'),
  HUB_INTERNAL_URL: z.string().url().default('https://hub.v79sl.com'),
  POS_PUBLIC_URL: z.string().url().default('https://pos.v79sl.com'),
  POS_SESSION_HOURS: z.coerce.number().int().min(1).max(24).default(8),
  V79_PLATFORM_SHARED_SECRET: z.string().default(''),
  CORS_ORIGINS: z.string().default(''),
  REPLENISHMENT_INTERVAL_MINUTES: z.coerce.number().int().min(5).default(60),
  LOG_LEVEL: z.string().default('info'),
  TRUST_PROXY: z.string().default('false'),
  GIFT_CARD_PEPPER: z.string().min(16).default('change-me-in-production-please'),
  ENCRYPTION_KEY: z.string().min(32).default('change-me-in-production-32-bytes-minimum')
});

const parsed = schema.parse(process.env);
const looksLikePlaceholder = (value: string) => /change[-_ ]?me|replace[-_ ]?(with)?/i.test(value);
if (parsed.NODE_ENV === 'production') {
  if (parsed.AUTH_MODE === 'dev') throw new Error('AUTH_MODE=dev is forbidden in production');
  if (looksLikePlaceholder(parsed.GIFT_CARD_PEPPER)) throw new Error('GIFT_CARD_PEPPER must be changed in production');
  if (looksLikePlaceholder(parsed.ENCRYPTION_KEY)) throw new Error('ENCRYPTION_KEY must be changed in production');
  if (!parsed.CORS_ORIGINS.trim()) throw new Error('CORS_ORIGINS must be explicitly configured in production');
  if (!parsed.V79_PLATFORM_SHARED_SECRET.trim() || looksLikePlaceholder(parsed.V79_PLATFORM_SHARED_SECRET)) throw new Error('V79_PLATFORM_SHARED_SECRET must be configured in production');
}
export const config = parsed;
export const corsOrigins = config.CORS_ORIGINS.split(',').map(v => v.trim()).filter(Boolean);
