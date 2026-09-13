/**
 * Seeds the superadmin from SEED_SUPERADMIN_* and, outside production, a demo tenant.
 * Idempotent: safe to run repeatedly.
 */
import { eq } from 'drizzle-orm';
import { db, pool } from './client.js';
import { bankAccounts, listingCategories, listingImages, listings, platformSettings, siteConfigs, tenantMembers, tenants, users } from './schema/index.js';
import { env } from '../config/env.js';
import { hashPassword } from '../lib/password.js';
import { defaultSiteConfig } from '../modules/site-config/site-schema.js';

async function main() {
  await db.insert(platformSettings).values({ id: 1 }).onConflictDoNothing();

  if (env.SEED_SUPERADMIN_EMAIL && env.SEED_SUPERADMIN_PASSWORD) {
    const existing = await db.query.users.findFirst({ where: eq(users.email, env.SEED_SUPERADMIN_EMAIL) });
    if (!existing) {
      await db.insert(users).values({
        email: env.SEED_SUPERADMIN_EMAIL,
        passwordHash: await hashPassword(env.SEED_SUPERADMIN_PASSWORD),
        name: 'Platform Admin',
        role: 'superadmin',
      });
      console.log(`superadmin created: ${env.SEED_SUPERADMIN_EMAIL}`);
    } else {
      console.log('superadmin exists');
    }
  }

  if (env.isProd) return;

  const demoEmail = 'demo@example.com';
  let owner = await db.query.users.findFirst({ where: eq(users.email, demoEmail) });
  if (!owner) {
    [owner] = await db
      .insert(users)
      .values({ email: demoEmail, passwordHash: await hashPassword('Demo1234!'), name: 'Dewi Rental', role: 'owner' })
      .returning();
  }
  if (!owner) throw new Error('owner');

  let tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, 'demo') });
  if (!tenant) {
    [tenant] = await db
      .insert(tenants)
      .values({
        slug: 'demo',
        name: 'Demo Rental Bali',
        tagline: 'Sewa motor & mobil di Bali, gampang dan cepat.',
        ownerUserId: owner.id,
        contact: { whatsapp: '+628123456789', phone: '+628123456789', email: demoEmail, address: 'Jl. Sunset Road No. 88, Kuta', city: 'Badung, Bali' },
      })
      .returning();
    if (!tenant) throw new Error('tenant');
    await db.insert(tenantMembers).values({ tenantId: tenant.id, userId: owner.id, role: 'owner' });
    await db.insert(siteConfigs).values({ tenantId: tenant.id, draft: defaultSiteConfig({ tenantName: tenant.name, tagline: tenant.tagline ?? '' }) });
    await db.insert(bankAccounts).values([
      { tenantId: tenant.id, bankName: 'BCA', accountNumber: '1234567890', holderName: 'Dewi Lestari', isPrimary: true },
      { tenantId: tenant.id, bankName: 'Mandiri', accountNumber: '9876543210', holderName: 'Dewi Lestari', sortOrder: 1 },
    ]);
    const [motor, mobil] = await db
      .insert(listingCategories)
      .values([
        { tenantId: tenant.id, slug: 'motor', name: 'Motor' },
        { tenantId: tenant.id, slug: 'mobil', name: 'Mobil', sortOrder: 1 },
      ])
      .returning();
    const created = await db
      .insert(listings)
      .values([
        {
          tenantId: tenant.id,
          categoryId: motor!.id,
          slug: 'honda-vario-160',
          name: 'Honda Vario 160',
          summary: 'Matic irit, cocok keliling Bali. Sudah termasuk 2 helm.',
          status: 'active',
          stockQuantity: 5,
          pricePerHour: 25_000,
          pricePerDay: 90_000,
          minHours: 3,
          depositAmount: 300_000,
          isFeatured: true,
          attributes: { Transmisi: 'Matic', Mesin: '160cc', Helm: '2' },
        },
        {
          tenantId: tenant.id,
          categoryId: motor!.id,
          slug: 'yamaha-nmax',
          name: 'Yamaha NMAX',
          summary: 'Nyaman untuk perjalanan jauh.',
          status: 'active',
          stockQuantity: 3,
          pricePerDay: 120_000,
          depositAmount: 500_000,
          isFeatured: true,
          attributes: { Transmisi: 'Matic', Mesin: '155cc' },
        },
        {
          tenantId: tenant.id,
          categoryId: mobil!.id,
          slug: 'toyota-avanza',
          name: 'Toyota Avanza',
          summary: '7 seater, AC dingin, lepas kunci.',
          status: 'active',
          stockQuantity: 2,
          pricePerDay: 350_000,
          minDays: 1,
          depositAmount: 1_000_000,
          deliveryEnabled: true,
          attributes: { Transmisi: 'Manual', Kursi: '7' },
        },
        {
          tenantId: tenant.id,
          categoryId: mobil!.id,
          slug: 'daihatsu-terios-draft',
          name: 'Daihatsu Terios',
          summary: 'Segera hadir.',
          status: 'draft',
          stockQuantity: 1,
          pricePerDay: 400_000,
        },
      ])
      .returning();
    await db.insert(listingImages).values(
      created.map((l, i) => ({
        listingId: l.id,
        url: `https://picsum.photos/seed/${l.slug}/1200/800`,
        pathname: `seed/${l.slug}.jpg`,
        alt: l.name,
        sortOrder: 0,
        width: 1200,
        height: 800,
        ...(i === 0 ? {} : {}),
      })),
    );
    console.log('demo tenant created: /demo (owner demo@example.com / Demo1234!)');
  } else {
    console.log('demo tenant exists');
  }
}

main()
  .then(async () => {
    await pool.end();
  })
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
