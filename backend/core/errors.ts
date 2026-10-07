/**
 * Erreurs applicatives.
 *
 * Chaque erreur exposée au client porte un code stable (contrat d'API),
 * un statut HTTP et un message utilisateur. Les détails internes restent
 * dans les logs ; ils ne sont jamais renvoyés au client.
 *
 * Phase 1 : uniquement les codes transverses. Les codes métier
 * (INVALID_QR, SCAN_TOO_SOON, …) seront ajoutés avec leurs modules.
 *
 * Phase 3A (Auth) : AUTH_REQUIRED/AUTH_INVALID/AUTH_FORBIDDEN/
 * ORIGIN_REJECTED. Le message utilisateur de AUTH_INVALID reste
 * volontairement générique — jamais de distinction externe entre compte
 * inconnu, mot de passe incorrect, mapping merchant absent ou désactivé.
 */

export const ERROR_CATALOG = {
  VALIDATION_FAILED: { status: 400, message: 'La requête est invalide.' },
  AUTH_REQUIRED: { status: 401, message: 'Authentification requise.' },
  AUTH_INVALID: { status: 401, message: 'Identifiants invalides.' },
  AUTH_FORBIDDEN: { status: 403, message: "Vous n'avez pas les droits nécessaires." },
  ORIGIN_REJECTED: { status: 403, message: 'Requête refusée.' },
  NOT_FOUND: { status: 404, message: 'Ressource introuvable.' },
  METHOD_NOT_ALLOWED: { status: 405, message: 'Méthode non autorisée.' },
  PAYLOAD_TOO_LARGE: { status: 413, message: 'La requête est trop volumineuse.' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: 'Type de contenu non pris en charge.' },
  RATE_LIMITED: { status: 429, message: 'Trop de requêtes. Réessayez dans un instant.' },
  INTERNAL_ERROR: { status: 500, message: 'Une erreur interne est survenue.' },
  SERVICE_UNAVAILABLE: { status: 503, message: 'Service momentanément indisponible.' },
} as const satisfies Record<string, { status: number; message: string }>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export type HttpErrorStatus = (typeof ERROR_CATALOG)[ErrorCode]['status'];

export interface AppErrorOptions {
  /** Message utilisateur spécifique (sinon : message du catalogue). */
  readonly userMessage?: string;
  /** Contexte pour les logs uniquement — jamais renvoyé au client. */
  readonly logContext?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: HttpErrorStatus;
  readonly userMessage: string;
  readonly logContext: Readonly<Record<string, unknown>>;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_CATALOG[code].status;
    this.userMessage = options.userMessage ?? ERROR_CATALOG[code].message;
    this.logContext = options.logContext ?? {};
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Corps de réponse d'erreur — format unique pour toute l'API. */
export interface ErrorBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly requestId: string;
  };
}

export function toErrorBody(error: AppError, requestId: string): ErrorBody {
  return { error: { code: error.code, message: error.userMessage, requestId } };
}

/** Configuration invalide au démarrage : jamais exposée au client. */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Configuration invalide : ${issues.join(' ; ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}
