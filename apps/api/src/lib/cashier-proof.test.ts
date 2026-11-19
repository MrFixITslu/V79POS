import { describe, expect, it, vi } from 'vitest';
import { issueCashierProof, verifyCashierProof } from './cashier-proof.js';

// Proof signing is a pure unit boundary: never require a database or live key.
vi.mock('./config.js', () => ({
  config: { ENCRYPTION_KEY: 'synthetic-cashier-unit-key-at-least-32-characters' }
}));

describe('cashier proof', () => {
  const identity = {
    tenantId: 'tenant-a',
    locationId: 'location-a',
    userId: 'cashier-a'
  };

  it('verifies only the exact tenant, location and cashier', () => {
    const proof = issueCashierProof(identity, 60_000);
    expect(verifyCashierProof(proof, identity)).toBe(true);
    expect(verifyCashierProof(proof, { ...identity, tenantId: 'tenant-b' })).toBe(false);
    expect(verifyCashierProof(proof, { ...identity, locationId: 'location-b' })).toBe(false);
    expect(verifyCashierProof(proof, { ...identity, userId: 'cashier-b' })).toBe(false);
  });

  it('rejects tampering', () => {
    const proof = issueCashierProof(identity, 60_000);
    const [payload, signature] = proof.split('.');
    expect(verifyCashierProof(`${payload}x.${signature}`, identity)).toBe(false);
    expect(verifyCashierProof(`${payload}.${signature.slice(0, -2)}00`, identity)).toBe(false);
  });

  it('rejects expired proofs', () => {
    const proof = issueCashierProof(identity, -1);
    expect(verifyCashierProof(proof, identity)).toBe(false);
  });
});
