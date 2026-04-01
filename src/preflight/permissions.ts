import { azJson, azTsv } from '../utils/az.js';
import type { PreflightResult } from '../types.js';

export async function checkSubscriptionRoles(subscriptionId: string): Promise<PreflightResult> {
  try {
    const oid = await azTsv('ad signed-in-user show --query id');
    const roles: { roleDefinitionName: string }[] = await azJson(
      `role assignment list --assignee ${oid} --scope /subscriptions/${subscriptionId} --query "[].{roleDefinitionName:roleDefinitionName}"`
    );

    const roleNames = roles.map(r => r.roleDefinitionName);
    const hasContributor = roleNames.some(r => r === 'Contributor' || r === 'Owner');
    const hasUAA = roleNames.some(r => r === 'User Access Administrator' || r === 'Owner');

    if (!hasContributor || !hasUAA) {
      const missing: string[] = [];
      if (!hasContributor) missing.push('Contributor');
      if (!hasUAA) missing.push('User Access Administrator');
      return {
        label: 'Subscription roles',
        passed: false,
        detail: `Missing: ${missing.join(', ')}`,
        remediation: `Assign roles: az role assignment create --role "${missing[0]}" --assignee ${oid} --scope /subscriptions/${subscriptionId}`,
      };
    }

    return {
      label: `Subscription roles: ${hasContributor ? 'Contributor ✓' : ''} ${hasUAA ? 'User Access Administrator ✓' : ''}`.trim(),
      passed: true,
    };
  } catch (err: any) {
    return { label: 'Subscription roles', passed: false, remediation: `Error checking roles: ${err.message}` };
  }
}

export async function checkEntraRole(): Promise<PreflightResult> {
  try {
    const memberships: { '@odata.type': string; displayName: string }[] = await azJson(
      `rest --method GET --uri "https://graph.microsoft.com/v1.0/me/memberOf" --headers "ConsistencyLevel=eventual" --query "value"`
    );

    const roleNames = memberships
      .filter(m => m['@odata.type'] === '#microsoft.graph.directoryRole')
      .map(m => m.displayName);

    const hasAppAdmin = roleNames.some(r =>
      r === 'Application Administrator' || r === 'Global Administrator' || r === 'Cloud Application Administrator'
    );

    if (!hasAppAdmin) {
      return {
        label: 'Entra: Application Administrator',
        passed: false,
        detail: `Your Entra roles: ${roleNames.join(', ') || 'none'}`,
        remediation: 'Assign Application Administrator role in Entra ID → Roles and administrators',
      };
    }

    return { label: 'Entra: Application Administrator ✓', passed: true };
  } catch (err: any) {
    return { label: 'Entra role check', passed: false, remediation: `Error: ${err.message}. Ensure you have Graph API permissions.` };
  }
}
