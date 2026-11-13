import { describe, expect, it } from 'vitest';
import { technicianRequestSchema, technicianUseSchema } from './validation.js';

const idempotency = '74fd17a1-cf1e-4bf0-8cd3-3e2dc1bd742e';
const base = {
  requestKey: idempotency,
  productVariantId: 'sku-one',
  quantity: 2
};

describe('technician stock movement validation', () => {
  it('accepts a traceable job use', () => {
    const parsed = technicianUseSchema.parse({ ...base, jobReference: 'TIQUET-007' });
    expect(parsed.quantity).toBe(2);
    expect(parsed.serialNumberIds).toEqual([]);
  });

  it.each([0, -1, Number.POSITIVE_INFINITY, 0.00001, 1.12345, 1000000001])(
    'rejects unsafe inventory quantity %s', quantity => {
      expect(technicianUseSchema.safeParse({ ...base, quantity, jobReference: 'TIQUET-007' }).success).toBe(false);
    }
  );

  it('rejects missing job references and malformed retry keys', () => {
    expect(technicianUseSchema.safeParse({ ...base, jobReference: '' }).success).toBe(false);
    expect(technicianUseSchema.safeParse({ ...base, requestKey: 'not-a-uuid', jobReference: 'T-123' }).success).toBe(false);
  });

  it('requires a reason and warehouse for all return types', () => {
    for (const purpose of ['TECHNICIAN_RETURN_GOOD', 'TECHNICIAN_RETURN_FAULTY']) {
      const valid = { ...base, purpose, warehouseId: 'warehouse-1', reason: 'Returned by technician' };
      expect(technicianRequestSchema.safeParse(valid).success).toBe(true);
      expect(technicianRequestSchema.safeParse({ ...valid, reason: ' ' }).success).toBe(false);
      expect(technicianRequestSchema.safeParse({ ...valid, warehouseId: '' }).success).toBe(false);
    }
  });

  it('rejects zero, negative and over-precision lot quantities', () => {
    for (const quantity of [-1, 0, 0.00001]) {
      expect(technicianUseSchema.safeParse({
        ...base, jobReference: 'T-123',
        lotAllocations: [{ lotId: 'lot-1', quantity }]
      }).success).toBe(false);
    }
  });
});
