import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { summariseProvisionalJobCost, validJobCostScope } from './job-cost-evidence.js';

const organizationId='org_v79_tenant_01';
const jobId='1b0af762-2d8e-4f0e-8d17-f49963fca21a';

describe('POS evidence-only cost contract',()=>{
  it('only accepts a tenant context and exact Tiquet UUID, never user names',()=>{
    expect(validJobCostScope(organizationId,jobId)).toBe(true);
    expect(validJobCostScope('wrong/tenant',jobId)).toBe(false);
    expect(validJobCostScope(organizationId,'TQ-1000')).toBe(false);
  });
  it('uses actual FIFO consumption with decimal precision, not product catalogue prices',()=>{
    const summary=summariseProvisionalJobCost(organizationId,jobId,'XCD',[
      {id:'usage1',quantity:new Prisma.Decimal('1.5000'),
        unitCost:new Prisma.Decimal('23.1450'),createdAt:new Date('2026-11-11T12:10:00Z')},
      {id:'usage2',quantity:new Prisma.Decimal('2.0000'),
        unitCost:new Prisma.Decimal('10.0000'),createdAt:new Date('2026-11-11T12:20:00Z')},
    ]);
    expect(summary.materialCost).toBe('54.72');
    expect(summary.recordedUsageCount).toBe(2);
    expect(summary.lastUsageAt).toBe('2026-11-11T12:20:00.000Z');
    expect(summary.linkage).toBe('staff_entered_reference_unverified');
    expect(summary.costCompleteness).toBe('unverified');
    expect(summary.profitMargin).toBeNull();
    expect(summary.isPaymentReceipt).toBe(false);
  });
  it('reports zero rows as zero provisional usage, not zero true cost',()=>{
    const summary=summariseProvisionalJobCost(organizationId,jobId,'XCD',[]);
    expect(summary.materialCost).toBe('0.00');
    expect(summary.lastUsageAt).toBeNull();
    expect(summary.costCompleteness).toBe('unverified');
  });
  it('fails closed when evidence is incomplete or source values are invalid',()=>{
    const row={id:'a',quantity:new Prisma.Decimal(1),
      unitCost:new Prisma.Decimal(10),createdAt:new Date('2026-11-11T12:00:00Z')};
    expect(()=>summariseProvisionalJobCost(organizationId,jobId,'XCD',
      Array.from({length:2001},()=>row))).toThrow();
    expect(()=>summariseProvisionalJobCost(organizationId,jobId,'XCD',
      [{...row,quantity:new Prisma.Decimal(-1)}])).toThrow();
    expect(()=>summariseProvisionalJobCost(organizationId,jobId,'XCD',
      [{...row,unitCost:new Prisma.Decimal(-1)}])).toThrow();
    expect(()=>summariseProvisionalJobCost(organizationId,jobId,'XCD',
      [{...row,createdAt:new Date('wrong')}])).toThrow();
    expect(()=>summariseProvisionalJobCost(organizationId,jobId,'xx',[])).toThrow();
  });
});
