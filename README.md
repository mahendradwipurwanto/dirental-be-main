# rental-api

Express 5 + TypeScript backend for the rental platform. Owns Postgres (Drizzle ORM), auth, bookings, payments
(manual bank transfer with proof upload), storefront configuration, uploads (S3-compatible object storage via presigned PUT), email (SMTP) and cron.

Deployed to Vercel with zero config: `src/index.ts` default-exports the Express app and becomes a single
Fluid Compute function. Static files go in `public/` (`express.static` is ignored on Vercel).

## Local development

```bash
cp .env.example .env            # fill in secrets; DATABASE_URL defaults to the docker container below
docker run -d --name rental-pg -e POSTGRES_USER=rental -e POSTGRES_PASSWORD=rental -e POSTGRES_DB=rental -p 5434:5432 postgres:17
pnpm install
pnpm db:migrate                 # applies src/db/migrations
pnpm db:seed                    # creates the superadmin from SEED_SUPERADMIN_* and a demo tenant in development
pnpm dev                        # http://localhost:4000
```

## Scripts

| Script | Purpose |
|---|---|
| `pnpm dev` | `tsx watch src/dev.ts` (local listener; Vercel never uses this file) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | vitest |
| `pnpm db:generate` / `db:migrate` | drizzle-kit migrations (never run at request time) |
| `pnpm gen:openapi` | writes `openapi.json` from the zod schemas; frontends generate types from it |
| `pnpm check:openapi` | fails if `openapi.json` is stale (CI) |

## Storefront config (schema v2)

`src/modules/site-config/site-schema.ts` is the source of truth (vendored into both Next apps with
`pnpm sync:schema`). A site = theme + nav + footer + SEO + `pages[]`; every page, including `home`, is an
ordered list of blocks (19 types: hero, heading, text, image, button, spacer, divider, columns, listing_grid,
listing_spotlight, gallery, faq, features, testimonials, cta, contact, map, video, stats). Each block has a
shared `style` (background, paddingY, width, align). Version-1 drafts (home-page `sections` plus rows in the
`pages` table) are migrated in place the first time the config is loaded; the `pages` table is no longer
written to.

## Conventions

- All routes live under `/v1`: `/public` (storefront, no auth), `/auth`, `/admin` (owner/staff, tenant-scoped),
  `/platform` (superadmin), `/internal/cron` (Vercel Cron), `/meta`.
- Errors are always `{ error: { code, message, issues? } }`.
- Money is integer IDR. Times are `timestamptz`; the tenant timezone (default `Asia/Jakarta`) is used for day math.
- Anything that runs after the response is sent must be wrapped in `waitUntil()` from `@vercel/functions`.
