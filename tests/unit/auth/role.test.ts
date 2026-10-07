import { describe, expect, it } from 'vitest';
import { AuthForbiddenError } from '../../../backend/auth/errors.js';
import { requireRole, roleSatisfies } from '../../../backend/auth/role.js';

describe('roleSatisfies', () => {
  it('owner satisfait owner et staff', () => {
    expect(roleSatisfies('owner', 'owner')).toBe(true);
    expect(roleSatisfies('owner', 'staff')).toBe(true);
  });

  it('staff satisfait staff mais pas owner', () => {
    expect(roleSatisfies('staff', 'staff')).toBe(true);
    expect(roleSatisfies('staff', 'owner')).toBe(false);
  });
});

describe('requireRole', () => {
  it('owner : ne lève rien pour une action owner-only', () => {
    expect(() => requireRole('owner', 'owner')).not.toThrow();
  });

  it('staff : ne lève rien pour une action staff', () => {
    expect(() => requireRole('staff', 'staff')).not.toThrow();
  });

  it('staff : rejette une action owner-only', () => {
    expect(() => requireRole('owner', 'staff')).toThrow(AuthForbiddenError);
  });
});
