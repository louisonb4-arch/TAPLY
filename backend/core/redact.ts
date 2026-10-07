/**
 * Masquage des secrets avant toute écriture de log.
 *
 * Deux protections cumulées :
 *  1. par CLÉ : toute valeur dont le nom ressemble à un secret est remplacée ;
 *  2. par MOTIF : dans les chaînes, les JWT, jetons Bearer/ApplePass, jetons
 *     Taply, cookies Taply et mots de passe d'URL de connexion sont masqués.
 *
 * Règle : en cas de doute, masquer.
 */

export const REDACTED = '[REDACTED]';

const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 4_000;

/** Noms de champs (normalisés : minuscules, sans - ni _) dont la valeur est toujours masquée. */
const SENSITIVE_KEY_FRAGMENTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'cookie',
  'apikey',
  'privatekey',
  'credential',
  'session',
  'signature',
  'connectionstring',
  'databaseurl',
  'keyring',
  'otp',
] as const;

/** Clés exactement sensibles qui ne contiennent aucun des fragments ci-dessus. */
const SENSITIVE_EXACT_KEYS = new Set(['key', 'pass', 'pwd', 'jwt', 'dsn', 'cert', 'p12', 'pem']);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, '');
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (SENSITIVE_EXACT_KEYS.has(normalized)) return true;
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

interface Pattern {
  readonly regex: RegExp;
  readonly replace: (match: string, ...groups: string[]) => string;
}

const PATTERNS: readonly Pattern[] = [
  // JWT (header.payload.signature, header base64url de {"…)
  {
    regex: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    replace: () => '[REDACTED_JWT]',
  },
  // Authorization: Bearer xxx / ApplePass xxx / Basic xxx
  {
    regex: /\b(Bearer|ApplePass|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: (_m, scheme) => `${scheme} ${REDACTED}`,
  },
  // Jetons Taply versionnés (ex. TP1.k2.<base64url>) : on garde un préfixe court
  {
    regex: /\b(TP\d+\.k\d+\.)([A-Za-z0-9_-]{6})[A-Za-z0-9_-]{10,}/g,
    replace: (_m, prefix, head) => `${prefix}${head}…`,
  },
  // Cookies Taply (__Host-taply_sid=…, __Host-taply_cd=…)
  {
    regex: /(__Host-taply_[a-z]+=)[^;\s,]+/gi,
    replace: (_m, name) => `${name}${REDACTED}`,
  },
  // Mot de passe dans une URL de connexion (postgres://user:pass@host)
  {
    regex: /\b([a-z][a-z0-9+.-]*:\/\/[^:/?#\s@]+:)[^@/\s]+@/gi,
    replace: (_m, prefix) => `${prefix}${REDACTED}@`,
  },
  // Paramètres de requête sensibles (?token=…, &access_token=…, &token_hash=…)
  {
    regex: /([?&](?:[a-z_]*token[a-z_]*|code|secret|password|key)=)[^&#\s]+/gi,
    replace: (_m, prefix) => `${prefix}${REDACTED}`,
  },
  // Blocs PEM (clés privées, certificats)
  {
    regex: /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
    replace: () => '[REDACTED_PEM]',
  },
];

export function redactString(input: string): string {
  let output = input.length > MAX_STRING_LENGTH ? `${input.slice(0, MAX_STRING_LENGTH)}…[truncated]` : input;
  for (const { regex, replace } of PATTERNS) {
    output = output.replace(regex, replace as (substring: string, ...args: string[]) => string);
  }
  return output;
}

function redactError(error: Error, seen: WeakSet<object>, depth: number): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    name: error.name,
    message: redactString(error.message),
  };
  if (error.stack !== undefined) serialized['stack'] = redactString(error.stack);
  if (error.cause !== undefined) serialized['cause'] = redactValue(error.cause, seen, depth + 1);
  return serialized;
}

function redactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol' || typeof value === 'function') return `[${typeof value}]`;
  if (depth >= MAX_DEPTH) return '[MaxDepth]';

  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (value instanceof Error) return redactError(value, seen, depth);
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Uint8Array) return `[binary ${value.byteLength} bytes]`;
    if (value instanceof URL) return redactString(value.toString());
    if (value instanceof Headers) {
      const headers: Record<string, unknown> = {};
      value.forEach((headerValue, headerName) => {
        headers[headerName] = isSensitiveKey(headerName) ? REDACTED : redactString(headerValue);
      });
      return headers;
    }
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactValue(item, seen, depth + 1));
      if (value.length > MAX_ARRAY_ITEMS) items.push(`[+${value.length - MAX_ARRAY_ITEMS} items]`);
      return items;
    }

    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = isSensitiveKey(key) ? REDACTED : redactValue(nested, seen, depth + 1);
    }
    return output;
  }

  return '[unserializable]';
}

/** Retourne une copie sûre à journaliser. Ne modifie jamais l'entrée. */
export function redact(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>(), 0);
}
