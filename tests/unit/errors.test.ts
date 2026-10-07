import { describe, expect, it } from 'vitest';
import { AppError, ConfigError, ERROR_CATALOG, isAppError, toErrorBody } from '../../backend/core/errors.js';

describe('AppError', () => {
  it('prend le statut et le message du catalogue', () => {
    const error = new AppError('NOT_FOUND');
    expect(error.code).toBe('NOT_FOUND');
    expect(error.status).toBe(404);
    expect(error.userMessage).toBe(ERROR_CATALOG.NOT_FOUND.message);
    expect(isAppError(error)).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
  });

  it('accepte un message utilisateur spécifique et un contexte de log séparé', () => {
    const error = new AppError('VALIDATION_FAILED', {
      userMessage: 'Champ manquant.',
      logContext: { field: 'email' },
    });
    expect(error.userMessage).toBe('Champ manquant.');
    expect(error.logContext).toEqual({ field: 'email' });
  });

  it("n'expose au client que code, message et requestId", () => {
    const error = new AppError('INTERNAL_ERROR', {
      logContext: { secretDetail: 'db exploded' },
      cause: new Error('stack interne'),
    });
    const body = toErrorBody(error, 'req-1');
    expect(body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: ERROR_CATALOG.INTERNAL_ERROR.message, requestId: 'req-1' },
    });
    expect(JSON.stringify(body)).not.toContain('db exploded');
    expect(JSON.stringify(body)).not.toContain('stack interne');
  });

  it('chaque code du catalogue a un statut HTTP 4xx/5xx et un message non vide', () => {
    for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
      expect(entry.status, code).toBeGreaterThanOrEqual(400);
      expect(entry.status, code).toBeLessThan(600);
      expect(entry.message.length, code).toBeGreaterThan(0);
    }
  });
});

describe('ConfigError', () => {
  it('liste les problèmes', () => {
    const error = new ConfigError(['A: requis', 'B: invalide']);
    expect(error.issues).toEqual(['A: requis', 'B: invalide']);
    expect(error.message).toContain('A: requis');
  });
});
