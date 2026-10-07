/**
 * Erreurs du domaine Auth — indépendantes du contrat HTTP
 * (`backend/core/errors.ts`). La correspondance avec un code/statut
 * d'API se fait à la frontière HTTP (`backend/http/routes/auth.ts`), qui
 * aplatit volontairement toutes ces erreurs vers la même réponse externe
 * générique : jamais de distinction observable entre « pas de compte »,
 * « mauvais mot de passe », « mapping absent » ou « mapping désactivé ».
 */

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

/** Identifiants invalides, ou mapping merchant absent — jamais distingué à l'extérieur. */
export class AuthInvalidCredentialsError extends Error {
  constructor() {
    super("identifiants invalides ou aucun mapping merchant actif — jamais distingué à l'extérieur");
    this.name = 'AuthInvalidCredentialsError';
  }
}

/** Session manquante, invalide, expirée ou révoquée — même réponse externe pour les quatre. */
export class SessionInvalidError extends Error {
  constructor() {
    super('session manquante, invalide, expirée ou révoquée');
    this.name = 'SessionInvalidError';
  }
}

export class AuthForbiddenError extends Error {
  constructor(requiredRole: string) {
    super(`rôle insuffisant pour cette action (requiert ${requiredRole})`);
    this.name = 'AuthForbiddenError';
  }
}
