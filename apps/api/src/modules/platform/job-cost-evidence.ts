import { Prisma } from '@prisma/client';

const ORG_ID=/^[A-Za-z0-9._:@-]{4,100}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validJobCostScope(organizationId: string,jobId: string): boolean {
  return ORG_ID.test(organizationId) && UUID.test(jobId);
}

export type PosJobCostLine = {
  id: string;
  quantity: Prisma.Decimal;
  unitCost: Prisma.Decimal;
  createdAt: Date;
};

/**
 * A POS jobReference is staff-supplied; it is NOT authenticated proof of
 * Tiquet job ownership. Return factual FIFO consumption only, clearly
 * marked provisional until a signed Tiquet association is established.
 *
 * This function never alters stock, invoices, payments or other ledgers.
 */
export function summariseProvisionalJobCost(
  organizationId:string,jobId:string,currency:string,lines:PosJobCostLine[],
) {
  if (!validJobCostScope(organizationId,jobId))throw new Error('Invalid job cost scope');
  if (!/^[A-Z]{3}$/.test(currency))throw new Error('Invalid tenant currency');
  if (!Array.isArray(lines) || lines.length > 2000)
    throw new Error('Job cost evidence set is incomplete');
  let total=new Prisma.Decimal(0);
  let mostRecent:Date|null=null;
  for(const line of lines){
    const qty=new Prisma.Decimal(line.quantity),unit=new Prisma.Decimal(line.unitCost);
    if(!qty.isFinite() || !unit.isFinite() || qty.lessThanOrEqualTo(0) || unit.lessThan(0))
      throw new Error('Invalid POS FIFO cost evidence');
    const at=line.createdAt;
    if(!(at instanceof Date)||!Number.isFinite(at.getTime()))
      throw new Error('Invalid POS cost timestamp');
    total=total.plus(unit.mul(qty));
    if(!mostRecent || at.getTime()>mostRecent.getTime())mostRecent=at;
  }
  return {
    contract:'v79.pos.job-cost-evidence.v1',
    organizationId,jobId,currency,
    evidenceSource:'pos_technician_usage_fifo',
    linkage:'staff_entered_reference_unverified',
    materialCost:total.toFixed(2),
    recordedUsageCount:lines.length,
    lastUsageAt:mostRecent?mostRecent.toISOString():null,
    costCompleteness:'unverified',
    profitMargin:null,
    isPaymentReceipt:false,
  } as const;
}
