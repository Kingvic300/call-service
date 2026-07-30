import { Meeting } from '../meeting/entities/meeting.entity';
import { DEFAULT_ROLE_PERMISSIONS, Permission } from '../interfaces/permission.enum';
import { ParticipantRole } from '../interfaces/role.enum';

/** Meeting-level overrides win over the default role matrix (spec: "Permissions must be configurable"). */
export function hasPermission(meeting: Meeting, role: ParticipantRole, permission: Permission): boolean {
  const override = meeting.permissionOverrides.get(permission);
  if (override !== undefined) return override;
  return DEFAULT_ROLE_PERMISSIONS[role].has(permission);
}
