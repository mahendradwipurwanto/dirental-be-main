import type { DbOrTx } from '../db/client.js';
import { auditLogs } from '../db/schema/index.js';

export type AuditEntry = {
  tenantId?: string | null;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  diff?: Record<string, unknown>;
  ip?: string | null;
};

export async function audit(dbx: DbOrTx, entry: AuditEntry): Promise<void> {
  await dbx.insert(auditLogs).values({
    tenantId: entry.tenantId ?? null,
    actorUserId: entry.actorUserId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    diff: entry.diff,
    ip: entry.ip ?? null,
  });
}
