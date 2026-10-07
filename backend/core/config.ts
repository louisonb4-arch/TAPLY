/**
 * Configuration typée, validée au démarrage par zod.
 *
 * - Aucune valeur par défaut silencieuse pour un réglage de sécurité.
 * - Aucun domaine codé en dur : les URL publiques viennent de l'environnement.
 * - Une configuration invalide lève `ConfigError` (le message ne contient
 *   jamais les valeurs, seulement les noms de variables et les règles).
 *
 * Phase 1 : seulement l'environnement, le niveau de log, la limite de corps
 * et les URL publiques (facultatives tant qu'aucun module ne les consomme).
 * Base de données, auth, Wallet : ajoutés dans leurs phases respectives.
 */

import { z } from 'zod';
import { ConfigError } from './errors.js';
import { LOG_LEVELS, type LogLevel } from './logger.js';

export const APP_ENVS = ['development', 'test', 'staging', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

export type EnvSource = Readonly<Record<string, string | undefined>>;

const optionalUrl = z
  .string()
  .trim()
  .min(1)
  .pipe(z.url({ protocol: /^https?$/ }))
  .transform((value) => value.replace(/\/+$/, ''))
  .optional();

const rawSchema = z.object({
  APP_ENV: z.enum(APP_ENVS).optional(),
  VERCEL_ENV: z.string().optional(),
  NODE_ENV: z.string().optional(),
  LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
  API_BODY_LIMIT_BYTES: z.coerce.number().int().min(1_024).max(1_048_576).optional(),
  PUBLIC_BASE_URL: optionalUrl,
  MERCHANT_APP_BASE_URL: optionalUrl,
  JOIN_BASE_URL: optionalUrl,
  WALLET_WEB_SERVICE_URL: optionalUrl,
});

export interface AppConfig {
  readonly appEnv: AppEnv;
  readonly logLevel: LogLevel;
  readonly api: {
    readonly bodyLimitBytes: number;
  };
  readonly urls: {
    readonly publicBase: string | undefined;
    readonly merchantAppBase: string | undefined;
    readonly joinBase: string | undefined;
    readonly walletWebService: string | undefined;
  };
}

/**
 * APP_ENV explicite si fourni ; sinon déduit de l'environnement Vercel :
 * production → production, preview → staging (les variables « Preview »
 * pointeront vers la préproduction), sinon development.
 */
function resolveAppEnv(raw: z.infer<typeof rawSchema>): AppEnv {
  if (raw.APP_ENV !== undefined) return raw.APP_ENV;
  if (raw.VERCEL_ENV === 'production') return 'production';
  if (raw.VERCEL_ENV === 'preview') return 'staging';
  if (raw.NODE_ENV === 'test') return 'test';
  return 'development';
}

function formatIssues(error: z.ZodError): string[] {
  // Nom de la variable + règle violée, jamais la valeur reçue.
  return error.issues.map((issue) => `${issue.path.join('.') || '(racine)'}: ${issue.message}`);
}

export function loadConfig(env: EnvSource): AppConfig {
  const parsed = rawSchema.safeParse(env);
  if (!parsed.success) throw new ConfigError(formatIssues(parsed.error));
  const raw = parsed.data;

  const appEnv = resolveAppEnv(raw);
  const deployed = appEnv === 'staging' || appEnv === 'production';

  const urls = {
    publicBase: raw.PUBLIC_BASE_URL,
    merchantAppBase: raw.MERCHANT_APP_BASE_URL,
    joinBase: raw.JOIN_BASE_URL,
    walletWebService: raw.WALLET_WEB_SERVICE_URL,
  } as const;

  const issues: string[] = [];
  if (deployed) {
    for (const [name, value] of Object.entries({
      PUBLIC_BASE_URL: urls.publicBase,
      MERCHANT_APP_BASE_URL: urls.merchantAppBase,
      JOIN_BASE_URL: urls.joinBase,
      WALLET_WEB_SERVICE_URL: urls.walletWebService,
    })) {
      if (value !== undefined && !value.startsWith('https://')) {
        issues.push(`${name}: HTTPS obligatoire en ${appEnv}`);
      }
    }
  }
  if (issues.length > 0) throw new ConfigError(issues);

  return {
    appEnv,
    logLevel: raw.LOG_LEVEL ?? (appEnv === 'development' ? 'debug' : 'info'),
    api: { bodyLimitBytes: raw.API_BODY_LIMIT_BYTES ?? 64 * 1_024 },
    urls,
  };
}

let cached: AppConfig | undefined;

/** Configuration du processus (chargée une seule fois). */
export function getConfig(): AppConfig {
  cached ??= loadConfig(process.env);
  return cached;
}
