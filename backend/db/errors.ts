/**
 * Erreurs du module base de données.
 *
 * Volontairement indépendantes du contrat HTTP (`backend/core/errors.ts`) :
 * la correspondance avec un code/statut d'API sera ajoutée quand des
 * routes consommeront ce module — pas encore le cas en Phase 2.
 */

export class DbConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbConfigError';
  }
}

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantContextError';
  }
}

export interface IdempotencyConflictParams {
  readonly merchantId: string;
  readonly operation: string;
  readonly idempotencyKey: string;
}

/** Même clé d'idempotence, empreinte de requête différente. */
export class IdempotencyConflictError extends Error {
  readonly merchantId: string;
  readonly operation: string;
  readonly idempotencyKey: string;

  constructor(params: IdempotencyConflictParams) {
    super(`Conflit d'idempotence (${params.operation}) : même clé, empreinte différente.`);
    this.name = 'IdempotencyConflictError';
    this.merchantId = params.merchantId;
    this.operation = params.operation;
    this.idempotencyKey = params.idempotencyKey;
  }
}
