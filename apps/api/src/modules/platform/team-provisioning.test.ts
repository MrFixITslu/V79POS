import { describe, expect, it } from 'vitest';
import { defaultHubTeamLocationCode, posRoleForHubTeamRole } from './team-provisioning.js';

describe('Hub team member POS role mapping', () => {
  it('maps Hub roles without granting POS owner or admin', () => {
    expect(posRoleForHubTeamRole('manager')).toBe('MANAGER');
    expect(posRoleForHubTeamRole('staff')).toBe('CASHIER');
    expect(posRoleForHubTeamRole('viewer')).toBe('AUDITOR');

    for (const role of ['manager', 'staff', 'viewer'] as const) {
      expect(['OWNER', 'ADMIN']).not.toContain(posRoleForHubTeamRole(role));
    }
  });

  it('defaults invited team members to the Main Store only', () => {
    expect(defaultHubTeamLocationCode).toBe('MAIN');
  });
});
