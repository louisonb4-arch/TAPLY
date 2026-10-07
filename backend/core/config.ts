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

/**
 * Chaîne de connexion Postgres (Transaction Pooler, rôle taply_app).
 * Jamais de contrôle sur le mot de passe ici : seul le schéma d'URL compte,
 * la valeur elle-même n'apparaît jamais dans un message d'erreur (redact.ts
 * masque aussi le mot de passe d'URL si jamais elle fuit vers un log).
 *
 * `sslmode`/`sslcert`/`sslkey`/`sslrootcert` sont interdits dans cette URL
 * dès que l'environnement est staging/production (voir plus bas) : le TLS
 * est configuré explicitement et exclusivement par `backend/db/pool.ts`
 * (objet `ssl` avec `ca` + `rejectUnauthorized: true`), jamais par des
 * paramètres d'URL qui pourraient diverger silencieusement de cet objet.
 */
const optionalPgUrl = z
  .string()
  .trim()
  .min(1)
  .refine((value) => /^postgres(ql)?:\/\//.test(value), 'doit commencer par postgres:// ou postgresql://')
  .optional();

/**
 * Certificat CA PEM de Supabase, nécessaire pour vérifier le certificat
 * serveur ET le hostname sans se reposer uniquement sur le magasin de
 * confiance système (voir backend/db/pool.ts). Si stocké dans
 * l'environnement avec des `\n` littéraux (fréquent : certaines interfaces
 * de variables d'environnement n'acceptent pas les retours à la ligne
 * réels), ils sont normalisés ici en vrais retours à la ligne.
 */
const optionalCaCert = z
  .string()
  .trim()
  .min(1)
  .transform((value) => value.replace(/\\n/g, '\n'))
  .refine(
    (value) => value.includes('-----BEGIN CERTIFICATE-----') && value.includes('-----END CERTIFICATE-----'),
    'doit être un certificat PEM (-----BEGIN CERTIFICATE----- … -----END CERTIFICATE-----)',
  )
  .optional();

const FORBIDDEN_URL_SSL_PARAMS = ['sslmode', 'sslcert', 'sslkey', 'sslrootcert'] as const;

/** Défaut par défaut documenté dans backend/db/pool.ts (bornes : 100 ms – 60 s). */
export const DEFAULT_DATABASE_CONNECTION_TIMEOUT_MS = 5_000;

/**
 * Borne la connexion (file d'attente du pool ET établissement d'une
 * connexion neuve — node-postgres utilise `connectionTimeoutMillis` pour
 * les deux, voir node_modules/pg-pool/index.js). `0`/absent chez pg
 * signifierait « jamais de timeout » — jamais ce que nous voulons, donc
 * zéro est explicitement hors bornes ici (minimum 100 ms). Maximum 60 s :
 * largement sous la limite Vercel (300 s par défaut), pour qu'une
 * connexion bloquée échoue vite plutôt que de consommer tout le budget
 * de la Function.
 */
const optionalConnectionTimeoutMs = z.coerce.number().int().min(100).max(60_000).optional();

/**
 * URL du projet Supabase (ex. https://xxxx.supabase.co). HTTPS obligatoire
 * dès que présent — pas seulement en staging/production : il n'y a aucun
 * scénario légitime où l'Auth Supabase tournerait en clair.
 */
const optionalSupabaseUrl = z
  .string()
  .trim()
  .min(1)
  .pipe(z.url({ protocol: /^https$/ }))
  .transform((value) => value.replace(/\/+$/, ''))
  .optional();

/**
 * Clé publishable Supabase — strictement le nouveau format
 * `sb_publishable_...`. Rien d'autre n'est accepté.
 *
 * Un `service_role`/`anon` legacy est un JWT (`eyJ...`) — le rôle est encodé
 * dans le payload, donc un test `includes('service_role')` sur la chaîne ne
 * détecte PAS fiablement une clé service_role legacy réelle (le payload est
 * base64, la sous-chaîne littérale n'y apparaît pas forcément telle quelle).
 * Plutôt que de tenter de décoder/filtrer des JWT legacy, on n'accepte que
 * le nouveau format `sb_publishable_...` et on rejette tout le reste,
 * y compris tout JWT (`eyJ...`), legacy anon ou service_role. Cette
 * nouvelle stack Taply 2026 n'a pas besoin de compatibilité legacy — le
 * modèle de clés actuel de Supabase remplace anon/service_role par
 * sb_publishable/sb_secret, et un service_role/secret contourne RLS :
 * le préfixe est la seule garantie fiable.
 */
const optionalSupabasePublishableKey = z
  .string()
  .trim()
  .min(1)
  .refine((value) => value.startsWith('sb_publishable_'), 'doit être une clé publishable au nouveau format (sb_publishable_...)')
  .optional();

/**
 * Origin exact attendu pour les requêtes mutantes (défense CSRF, voir
 * backend/http/origin.ts). Doit être une origin pure — pas un chemin, pas
 * de query — vérifié en comparant `new URL(value).origin` à la valeur
 * fournie telle quelle.
 */
const optionalAppOrigin = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    try {
      return new URL(value).origin === value;
    } catch {
      return false;
    }
  }, 'doit être une origin exacte (schéma://hôte[:port], sans chemin ni requête)')
  .optional();

const SESSION_SECONDS_MIN = 60;
const SESSION_SECONDS_MAX = 2_592_000; // 30 jours — plafond de bon sens, jamais « illimité ».
export const DEFAULT_SESSION_IDLE_SECONDS = 7_200; // 2 h
export const DEFAULT_SESSION_ABSOLUTE_SECONDS = 43_200; // 12 h

const optionalSessionSeconds = z.coerce.number().int().min(SESSION_SECONDS_MIN).max(SESSION_SECONDS_MAX).optional();

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
  DATABASE_URL_APP: optionalPgUrl,
  DATABASE_CA_CERT: optionalCaCert,
  DATABASE_CONNECTION_TIMEOUT_MS: optionalConnectionTimeoutMs,
  SUPABASE_URL: optionalSupabaseUrl,
  SUPABASE_PUBLISHABLE_KEY: optionalSupabasePublishableKey,
  APP_ORIGIN: optionalAppOrigin,
  SESSION_IDLE_SECONDS: optionalSessionSeconds,
  SESSION_ABSOLUTE_SECONDS: optionalSessionSeconds,
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
  readonly db: {
    /** Transaction Pooler, rôle taply_app. Absent : aucun module DB ne doit démarrer. */
    readonly appUrl: string | undefined;
    /** Certificat CA PEM Supabase, retours à la ligne réels (normalisés). */
    readonly caCert: string | undefined;
    /** Toujours résolu (défaut sûr si absent) — jamais 0/illimité. Pas un secret. */
    readonly connectionTimeoutMs: number;
  };
  readonly auth: {
    /** URL du projet Supabase. Absent : aucun module Auth ne doit démarrer. */
    readonly supabaseUrl: string | undefined;
    /** Clé publishable (jamais secrète — vérifié à la validation). */
    readonly supabasePublishableKey: string | undefined;
    /** Origin exact attendu pour les requêtes mutantes (défense CSRF). */
    readonly appOrigin: string | undefined;
    /** Toujours résolus (défauts sûrs) — jamais 0/négatif/illimité. */
    readonly sessionIdleSeconds: number;
    readonly sessionAbsoluteSeconds: number;
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
    // TLS configuré exclusivement par l'objet `ssl` explicite de
    // backend/db/pool.ts (ca + rejectUnauthorized: true) : aucun paramètre
    // ssl* dans l'URL, pour qu'il n'existe qu'une seule source de vérité,
    // jamais deux configurations qui pourraient diverger silencieusement.
    if (raw.DATABASE_URL_APP !== undefined) {
      const lowerUrl = raw.DATABASE_URL_APP.toLowerCase();
      for (const param of FORBIDDEN_URL_SSL_PARAMS) {
        if (lowerUrl.includes(`${param}=`)) {
          issues.push(`DATABASE_URL_APP: paramètre ${param} interdit en ${appEnv} (TLS géré par backend/db/pool.ts, pas par l'URL)`);
        }
      }
      // CA obligatoire seulement si la DB est effectivement configurée :
      // un déploiement staging/production qui ne branche encore aucun
      // module DB ne doit pas être bloqué par une variable sans objet.
      if (raw.DATABASE_CA_CERT === undefined) {
        issues.push(`DATABASE_CA_CERT: obligatoire en ${appEnv} dès que DATABASE_URL_APP est défini`);
      }
    }
  }

  const sessionIdleSeconds = raw.SESSION_IDLE_SECONDS ?? DEFAULT_SESSION_IDLE_SECONDS;
  const sessionAbsoluteSeconds = raw.SESSION_ABSOLUTE_SECONDS ?? DEFAULT_SESSION_ABSOLUTE_SECONDS;
  // Une session ne peut jamais être prolongée au-delà de son expiration
  // absolue (voir backend/auth/session.ts) — incohérent de configurer le
  // contraire, donc refusé dès la configuration plutôt qu'en silence au
  // premier touch().
  if (sessionIdleSeconds > sessionAbsoluteSeconds) {
    issues.push('SESSION_IDLE_SECONDS: doit être inférieur ou égal à SESSION_ABSOLUTE_SECONDS');
  }

  if (issues.length > 0) throw new ConfigError(issues);

  return {
    appEnv,
    logLevel: raw.LOG_LEVEL ?? (appEnv === 'development' ? 'debug' : 'info'),
    api: { bodyLimitBytes: raw.API_BODY_LIMIT_BYTES ?? 64 * 1_024 },
    urls,
    db: {
      appUrl: raw.DATABASE_URL_APP,
      caCert: raw.DATABASE_CA_CERT,
      connectionTimeoutMs: raw.DATABASE_CONNECTION_TIMEOUT_MS ?? DEFAULT_DATABASE_CONNECTION_TIMEOUT_MS,
    },
    auth: {
      supabaseUrl: raw.SUPABASE_URL,
      supabasePublishableKey: raw.SUPABASE_PUBLISHABLE_KEY,
      appOrigin: raw.APP_ORIGIN,
      sessionIdleSeconds,
      sessionAbsoluteSeconds,
    },
  };
}

let cached: AppConfig | undefined;

/** Configuration du processus (chargée une seule fois). */
export function getConfig(): AppConfig {
  cached ??= loadConfig(process.env);
  return cached;
}
