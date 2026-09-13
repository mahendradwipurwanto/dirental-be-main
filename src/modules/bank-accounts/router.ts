import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { bankAccounts, type BankAccount } from '../../db/schema/index.js';
import { audit } from '../../lib/audit.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { clientIp } from '../../lib/rate-limit.js';
import { revalidateTenant } from '../../lib/revalidate.js';
import { createRouter } from '../../lib/route.js';
import { idParams, isoDate, OK, okResponse } from '../../lib/schemas.js';
import { requireAuth, requireTrustedOrigin } from '../../middleware/auth.js';
import { authOf, requireOwner, resolveTenant, tenantOf } from '../../middleware/tenant.js';

export const bankAccountSchema = z.object({
  id: z.string().uuid(),
  bankName: z.string(),
  accountNumber: z.string(),
  holderName: z.string(),
  isPrimary: z.boolean(),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  createdAt: isoDate,
});

/** What customers see on the payment page. */
export const publicBankAccountSchema = bankAccountSchema.pick({ id: true, bankName: true, accountNumber: true, holderName: true, isPrimary: true });

const createBody = z.object({
  bankName: z.string().trim().min(2).max(60),
  accountNumber: z.string().trim().regex(/^[0-9 -]{4,40}$/, 'Digits only'),
  holderName: z.string().trim().min(2).max(80),
  isPrimary: z.boolean().default(false),
});
const updateBody = createBody.partial().extend({ isActive: z.boolean().optional() });

export const toBankAccountDto = (b: BankAccount) => ({
  id: b.id,
  bankName: b.bankName,
  accountNumber: b.accountNumber,
  holderName: b.holderName,
  isPrimary: b.isPrimary,
  isActive: b.isActive,
  sortOrder: b.sortOrder,
  createdAt: b.createdAt,
});

export async function listBankAccounts(tenantId: string, activeOnly = false) {
  return db.query.bankAccounts.findMany({
    where: and(eq(bankAccounts.tenantId, tenantId), activeOnly ? eq(bankAccounts.isActive, true) : undefined),
    orderBy: [asc(bankAccounts.sortOrder), asc(bankAccounts.createdAt)],
  });
}

const { router, route } = createRouter('/v1/admin', {
  tag: 'Admin',
  auth: 'cookie',
  middlewares: [requireTrustedOrigin, requireAuth, resolveTenant],
});

route({ method: 'get', path: '/bank-accounts', operationId: 'adminListBankAccounts', summary: 'List bank accounts', response: z.array(bankAccountSchema) }, async (req) =>
  (await listBankAccounts(tenantOf(req).id)).map(toBankAccountDto),
);

route(
  { method: 'post', path: '/bank-accounts', operationId: 'adminCreateBankAccount', summary: 'Add a bank account', body: createBody, response: bankAccountSchema, status: 201, middlewares: [requireOwner] },
  async (req) => {
    const tenant = tenantOf(req);
    const auth = authOf(req);
    const existing = await listBankAccounts(tenant.id);
    if (existing.length >= 10) throw unprocessable('At most 10 bank accounts', [{ path: 'body', message: 'Limit reached' }]);
    const makePrimary = req.valid.body.isPrimary || existing.length === 0;
    const row = await db.transaction(async (tx) => {
      if (makePrimary) await tx.update(bankAccounts).set({ isPrimary: false }).where(eq(bankAccounts.tenantId, tenant.id));
      const [created] = await tx
        .insert(bankAccounts)
        .values({ ...req.valid.body, tenantId: tenant.id, isPrimary: makePrimary, sortOrder: existing.length })
        .returning();
      return created!;
    });
    await audit(db, { tenantId: tenant.id, actorUserId: auth.userId, action: 'bank_account.create', entityType: 'bank_account', entityId: row.id, ip: clientIp(req) });
    revalidateTenant(tenant.slug);
    return toBankAccountDto(row);
  },
);

route(
  { method: 'patch', path: '/bank-accounts/:id', operationId: 'adminUpdateBankAccount', summary: 'Update a bank account', params: idParams, body: updateBody, response: bankAccountSchema, middlewares: [requireOwner] },
  async (req) => {
    const tenant = tenantOf(req);
    const { isPrimary, ...rest } = req.valid.body;
    const row = await db.transaction(async (tx) => {
      if (isPrimary) await tx.update(bankAccounts).set({ isPrimary: false }).where(eq(bankAccounts.tenantId, tenant.id));
      const [updated] = await tx
        .update(bankAccounts)
        .set({ ...rest, ...(isPrimary !== undefined ? { isPrimary } : {}) })
        .where(and(eq(bankAccounts.tenantId, tenant.id), eq(bankAccounts.id, req.valid.params.id)))
        .returning();
      return updated;
    });
    if (!row) throw notFound('Bank account not found');
    revalidateTenant(tenant.slug);
    return toBankAccountDto(row);
  },
);

route(
  { method: 'delete', path: '/bank-accounts/:id', operationId: 'adminDeleteBankAccount', summary: 'Delete a bank account', params: idParams, response: okResponse, middlewares: [requireOwner] },
  async (req) => {
    const tenant = tenantOf(req);
    const auth = authOf(req);
    const [row] = await db.delete(bankAccounts).where(and(eq(bankAccounts.tenantId, tenant.id), eq(bankAccounts.id, req.valid.params.id))).returning();
    if (!row) throw notFound('Bank account not found');
    if (row.isPrimary) {
      const next = (await listBankAccounts(tenant.id))[0];
      if (next) await db.update(bankAccounts).set({ isPrimary: true }).where(eq(bankAccounts.id, next.id));
    }
    await audit(db, { tenantId: tenant.id, actorUserId: auth.userId, action: 'bank_account.delete', entityType: 'bank_account', entityId: row.id, ip: clientIp(req) });
    revalidateTenant(tenant.slug);
    return OK;
  },
);

export const adminBankAccountsRouter = router;
