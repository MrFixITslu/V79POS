export const hubTeamRoles = ['manager', 'staff', 'viewer'] as const;
export type HubTeamRole = (typeof hubTeamRoles)[number];

const roleMap: Record<HubTeamRole, string> = {
  manager: 'MANAGER',
  staff: 'CASHIER',
  viewer: 'AUDITOR',
};

export function posRoleForHubTeamRole(role: HubTeamRole) {
  return roleMap[role];
}

export function canHubDeactivatePosRole(roleKey: string) {
  return !['OWNER', 'ADMIN'].includes(roleKey);
}

export const defaultHubTeamLocationCode = 'MAIN';
