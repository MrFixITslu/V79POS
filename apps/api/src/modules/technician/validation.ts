import { z } from 'zod';

// PostgreSQL stock quantities use DECIMAL(18,4). Never silently round a movement to zero.
export const stockQuantity = z.number().finite().min(0.0001).max(1000000000)
  .refine(value => Number(value.toFixed(4)) === value, 'Use at most four decimal places');

const allocation = z.object({ lotId: z.string().min(1), quantity: stockQuantity });
export const technicianItemSchema = z.object({
  productVariantId: z.string().min(1),
  quantity: stockQuantity,
  serialNumberIds: z.array(z.string().min(1)).max(100).default([]),
  lotAllocations: z.array(allocation).max(100).default([])
});

export const technicianRequestSchema = technicianItemSchema.extend({
  purpose: z.enum(['TECHNICIAN_ISSUE', 'TECHNICIAN_RETURN_GOOD', 'TECHNICIAN_RETURN_FAULTY']),
  warehouseId: z.string().min(1),
  requestKey: z.string().uuid(),
  jobReference: z.string().trim().max(120).optional(),
  reason: z.string().trim().min(3).max(500)
});

export const technicianUseSchema = technicianItemSchema.extend({
  requestKey: z.string().uuid(),
  jobReference: z.string().trim().min(2).max(120)
});
