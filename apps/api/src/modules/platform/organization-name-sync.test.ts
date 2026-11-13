import { describe, it, expect } from 'vitest';
import { hubOrgNameSchema, hubOrgNameHash } from './organization-name-sync.js';

const valid = () => ({
  eventId: 'event-01', organizationId: 'org-example-123', destination: 'pos',
  name: 'Vision79 Digital', nameRevision: 10,
});

describe('POS Hub organisation-name validation', () => {
  it('accepts the signed-worker payload shape', () => {
    expect(hubOrgNameSchema.parse(valid())).toEqual(valid());
  });
  it('produces a stable event hash', () => {
    expect(hubOrgNameHash(hubOrgNameSchema.parse(valid()))).toHaveLength(64);
    expect(hubOrgNameHash(hubOrgNameSchema.parse(valid()))).toBe(hubOrgNameHash(hubOrgNameSchema.parse(valid())));
  });
  it('rejects wrong destinations', () => {
    expect(() => hubOrgNameSchema.parse({ ...valid(), destination: 'tiquet' })).toThrow();
  });
  it('rejects a stale zero revision', () => {
    expect(() => hubOrgNameSchema.parse({ ...valid(), nameRevision: 0 })).toThrow();
  });
  it('rejects fractional revisions', () => {
    expect(() => hubOrgNameSchema.parse({ ...valid(), nameRevision: 1.5 })).toThrow();
  });
  it('rejects whitespace-padded names', () => {
    expect(() => hubOrgNameSchema.parse({ ...valid(), name: ' New name' })).toThrow();
  });
  it('rejects control characters in names', () => {
    expect(() => hubOrgNameSchema.parse({ ...valid(), name: 'A\nB' })).toThrow();
  });
  it('rejects unexpected properties', () => {
    expect(() => hubOrgNameSchema.parse({ ...valid(), otherTenantId: 'other' })).toThrow();
  });
  it('rejects unsafe revisions', () => {
    expect(() => hubOrgNameSchema.parse({ ...valid(), nameRevision: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  });
});
