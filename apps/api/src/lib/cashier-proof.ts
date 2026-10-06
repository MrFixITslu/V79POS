import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

type CashierProof = {
  tenantId: string;
  locationId: string;
  userId: string;
  expiresAt: number;
  nonce: string;
};

const proofKey = createHmac('sha256', config.ENCRYPTION_KEY).update('v79-pos/cashier-proof/v1').digest();
const sign = (payload: string) => createHmac('sha256', proofKey).update(payload).digest('hex');

export function issueCashierProof(input: Omit<CashierProof, 'expiresAt' | 'nonce'>, ttlMs = 5 * 60_000) {
  const body: CashierProof = {
    ...input,
    expiresAt: Date.now() + ttlMs,
    nonce: randomBytes(12).toString('base64url')
  };
  const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  return `${encoded}.${sign(encoded)}`;
}

export function verifyCashierProof(token: string, expected: Omit<CashierProof, 'expiresAt' | 'nonce'>) {
  try {
    const [encoded, signature] = token.split('.');
    if (!encoded || !signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
    const expectedSig = Buffer.from(sign(encoded), 'hex');
    const suppliedSig = Buffer.from(signature, 'hex');
    if (expectedSig.length !== suppliedSig.length || !timingSafeEqual(expectedSig, suppliedSig)) return false;
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as CashierProof;
    return payload.expiresAt >= Date.now()
      && payload.tenantId === expected.tenantId
      && payload.locationId === expected.locationId
      && payload.userId === expected.userId;
  } catch {
    return false;
  }
}
