/**
 * Storefront site configuration schema, version 2: component-based pages.
 *
 * SOURCE OF TRUTH: rental-api/src/modules/site-config/site-schema.ts
 * This file is vendored verbatim into rental-web and rental-admin (`pnpm sync:schema`).
 * Keep it dependency-free apart from zod, and give every field a default so older drafts keep parsing.
 *
 * A site is a theme + navigation + footer + a list of pages. Every page (including the home page,
 * slug `home`) is an ordered list of blocks. Blocks carry their own props plus a shared `style`
 * (background, vertical padding, width, alignment). `columns` is the only nesting block and may hold
 * any leaf block, so layouts stay one level deep and predictable for owners.
 */
import { z } from 'zod';

export const SITE_SCHEMA_VERSION = 2 as const;
export const HOME_SLUG = 'home';

export const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])?$/;

/** Slugs that collide with platform routes or would be confusing as storefront paths. */
export const RESERVED_SLUGS = [
  'about', 'admin', 'api', 'app', 'assets', 'blog', 'booking', 'bookings', 'browse', 'checkout', 'contact', 'dashboard',
  'docs', 'en', 'favicon.ico', 'help', 'id', 'items', 'login', 'logout', 'lp', 'me', 'p', 'platform', 'preview',
  'pricing', 'privacy', 'robots.txt', 'search', 'settings', 'signup', 'sitemap.xml', 'static', 'status',
  'support', 'terms', 'www', '_next',
] as const;

/** Page slugs that clash with storefront routes. */
export const RESERVED_PAGE_SLUGS = ['items', 'booking', 'checkout', 'p', 'preview', 'api'] as const;

export function isSlugValid(slug: string): boolean {
  return SLUG_REGEX.test(slug) && !(RESERVED_SLUGS as readonly string[]).includes(slug);
}

// ---------- primitives ----------

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a 6-digit hex colour');
const shortText = (max: number) => z.string().trim().max(max);
const optionalUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => v === '' || /^https?:\/\//.test(v), 'Must be an http(s) URL')
  .default('');

/** Tiptap / ProseMirror document. Rendered with a fixed extension set on the storefront. */
export const richTextSchema = z.object({
  type: z.literal('doc'),
  content: z.array(z.unknown()).optional(),
});
export type RichTextDoc = z.infer<typeof richTextSchema>;
export const emptyDoc = (): RichTextDoc => ({ type: 'doc', content: [] });
export const paragraphDoc = (text: string): RichTextDoc => ({ type: 'doc', content: text ? [{ type: 'paragraph', content: [{ type: 'text', text }] }] : [] });

export const FONT_FAMILIES = ['inter', 'plus-jakarta-sans', 'poppins', 'manrope', 'dm-sans', 'nunito', 'lora', 'playfair-display'] as const;
export type FontFamily = (typeof FONT_FAMILIES)[number];

export const RADIUS_OPTIONS = ['none', 'sm', 'md', 'lg', 'xl'] as const;
export type RadiusOption = (typeof RADIUS_OPTIONS)[number];

/** Icons owners can pick for feature lists; the storefront maps names to lucide icons. */
export const ICONS = ['check', 'star', 'clock', 'shield', 'map-pin', 'truck', 'phone', 'wallet', 'key', 'calendar', 'heart', 'sparkles'] as const;
export type IconName = (typeof ICONS)[number];

// ---------- theme ----------

export const themeSchema = z.object({
  logoUrl: optionalUrl,
  primary: hexColor.default('#0f766e'),
  secondary: hexColor.default('#f2b33d'),
  background: hexColor.default('#ffffff'),
  foreground: hexColor.default('#14302b'),
  fontFamily: z.enum(FONT_FAMILIES).default('plus-jakarta-sans'),
  radius: z.enum(RADIUS_OPTIONS).default('md'),
});
export type Theme = z.infer<typeof themeSchema>;

// ---------- navigation / footer / seo ----------

export const NAV_KINDS = ['home', 'catalog', 'page', 'block', 'external'] as const;

export const navItemSchema = z.object({
  id: z.string().min(1),
  label: shortText(40).min(1),
  kind: z.enum(NAV_KINDS).default('page'),
  /** page slug, block id (anchor on the home page), or absolute URL depending on `kind`. */
  target: shortText(2048).default(''),
});
export type NavItem = z.infer<typeof navItemSchema>;

export const seoSchema = z.object({
  title: shortText(70).default(''),
  description: shortText(200).default(''),
  ogImageUrl: optionalUrl,
});

export const footerSchema = z.object({
  text: shortText(300).default(''),
  showContact: z.boolean().default(true),
  showPages: z.boolean().default(true),
  showPoweredBy: z.boolean().default(true),
});

// ---------- block style (shared by every block) ----------

export const BACKGROUNDS = ['none', 'muted', 'accent', 'primary', 'secondary', 'ink', 'custom'] as const;
export const PADDINGS = ['none', 'sm', 'md', 'lg', 'xl'] as const;
export const WIDTHS = ['narrow', 'default', 'wide', 'full'] as const;
export const TEXT_COLORS = ['auto', 'light', 'dark', 'custom'] as const;

/**
 * Shared by every block. A background image (with a darkening overlay) and an explicit text colour can
 * be applied to any block, so owners can build their own hero-like sections from a group of blocks.
 */
export const blockStyleSchema = z.object({
  background: z.enum(BACKGROUNDS).default('none'),
  customColor: hexColor.default('#f3f4f6'),
  backgroundImageUrl: optionalUrl,
  /** Darkness of the overlay on top of the background image, 0–90 (%). */
  backgroundOverlay: z.number().int().min(0).max(90).default(40),
  textColor: z.enum(TEXT_COLORS).default('auto'),
  customTextColor: hexColor.default('#ffffff'),
  paddingY: z.enum(PADDINGS).default('md'),
  width: z.enum(WIDTHS).default('default'),
  align: z.enum(['left', 'center']).default('left'),
});
export type BlockStyle = z.infer<typeof blockStyleSchema>;

const blockBase = {
  id: z.string().min(1),
  hidden: z.boolean().default(false),
  style: blockStyleSchema.prefault({}),
};

/** Link target shared by buttons, heroes and images. */
export const LINK_KINDS = ['catalog', 'page', 'external', 'whatsapp', 'block'] as const;
export const BUTTON_VARIANTS = ['primary', 'secondary', 'outline', 'link'] as const;

export const buttonItemSchema = z.object({
  id: z.string().min(1),
  label: shortText(40).min(1),
  kind: z.enum(LINK_KINDS).default('catalog'),
  target: shortText(2048).default(''),
  variant: z.enum(BUTTON_VARIANTS).default('primary'),
});
export type ButtonItem = z.infer<typeof buttonItemSchema>;

const linkFields = {
  ctaLabel: shortText(40).default(''),
  ctaKind: z.enum(LINK_KINDS).default('catalog'),
  ctaTarget: shortText(2048).default(''),
};

// ---------- leaf blocks ----------

export const HERO_LAYOUTS = ['cover', 'split', 'plain'] as const;

/**
 * Hero: `cover` puts the image behind the text, `split` puts it beside the text, `plain` uses the
 * block style only. Any number of text lines (eyebrow, title, subtitle, rich body) and up to three buttons.
 */
export const heroBlockSchema = z.object({
  ...blockBase,
  type: z.literal('hero'),
  layout: z.enum(HERO_LAYOUTS).default('cover'),
  eyebrow: shortText(80).default(''),
  title: shortText(160).default(''),
  subtitle: shortText(400).default(''),
  body: richTextSchema.default(emptyDoc()),
  imageUrl: optionalUrl,
  imageAlt: shortText(160).default(''),
  /** For `split`: which side the image sits on. */
  imagePosition: z.enum(['left', 'right']).default('right'),
  /** For `cover`: darkness of the overlay on the image, 0–90 (%). */
  overlay: z.number().int().min(0).max(90).default(45),
  height: z.enum(['sm', 'md', 'lg', 'screen']).default('md'),
  buttons: z.array(buttonItemSchema).max(3).default([]),
});

export const headingBlockSchema = z.object({
  ...blockBase,
  type: z.literal('heading'),
  text: shortText(160).default(''),
  subtext: shortText(400).default(''),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  size: z.enum(['sm', 'md', 'lg', 'xl']).default('md'),
});

export const textBlockSchema = z.object({
  ...blockBase,
  type: z.literal('text'),
  content: richTextSchema.default(emptyDoc()),
  size: z.enum(['md', 'lg']).default('md'),
});

export const imageBlockSchema = z.object({
  ...blockBase,
  type: z.literal('image'),
  url: optionalUrl,
  alt: shortText(160).default(''),
  caption: shortText(200).default(''),
  ratio: z.enum(['auto', '16:9', '4:3', '1:1', '3:4']).default('auto'),
  size: z.enum(['full', 'lg', 'md', 'sm']).default('full'),
  rounded: z.boolean().default(true),
  linkKind: z.enum(['none', ...LINK_KINDS]).default('none'),
  linkTarget: shortText(2048).default(''),
});

/** One or more buttons in a row. */
export const buttonBlockSchema = z.object({
  ...blockBase,
  type: z.literal('button'),
  buttons: z.array(buttonItemSchema).max(4).default([]),
  size: z.enum(['md', 'lg']).default('md'),
});

export const spacerBlockSchema = z.object({
  ...blockBase,
  type: z.literal('spacer'),
  size: z.enum(['sm', 'md', 'lg']).default('md'),
});

export const dividerBlockSchema = z.object({
  ...blockBase,
  type: z.literal('divider'),
});

export const listingGridBlockSchema = z.object({
  ...blockBase,
  type: z.literal('listing_grid'),
  title: shortText(80).default('Katalog'),
  source: z.enum(['all', 'featured', 'category']).default('all'),
  category: shortText(60).default(''),
  limit: z.number().int().min(1).max(48).default(8),
  columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(4),
  showSearch: z.boolean().default(false),
  showCategories: z.boolean().default(false),
  showViewAll: z.boolean().default(true),
});

export const listingSpotlightBlockSchema = z.object({
  ...blockBase,
  type: z.literal('listing_spotlight'),
  listingSlug: shortText(80).default(''),
  eyebrow: shortText(60).default(''),
  note: shortText(300).default(''),
  imagePosition: z.enum(['left', 'right']).default('left'),
});

export const galleryImageSchema = z.object({ url: z.string().url(), alt: shortText(120).default('') });

export const galleryBlockSchema = z.object({
  ...blockBase,
  type: z.literal('gallery'),
  title: shortText(80).default(''),
  images: z.array(galleryImageSchema).max(24).default([]),
  columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(3),
});

export const faqItemSchema = z.object({ id: z.string().min(1), question: shortText(200).min(1), answer: shortText(2000).default('') });

export const faqBlockSchema = z.object({
  ...blockBase,
  type: z.literal('faq'),
  title: shortText(80).default('Pertanyaan umum'),
  items: z.array(faqItemSchema).max(30).default([]),
});

export const featureItemSchema = z.object({ id: z.string().min(1), icon: z.enum(ICONS).default('check'), title: shortText(80).min(1), body: shortText(300).default('') });

export const featuresBlockSchema = z.object({
  ...blockBase,
  type: z.literal('features'),
  title: shortText(80).default(''),
  items: z.array(featureItemSchema).max(12).default([]),
  columns: z.union([z.literal(2), z.literal(3)]).default(3),
});

export const testimonialItemSchema = z.object({ id: z.string().min(1), quote: shortText(500).min(1), name: shortText(80).default(''), meta: shortText(80).default('') });

export const testimonialsBlockSchema = z.object({
  ...blockBase,
  type: z.literal('testimonials'),
  title: shortText(80).default('Kata pelanggan'),
  items: z.array(testimonialItemSchema).max(12).default([]),
});

export const ctaBlockSchema = z.object({
  ...blockBase,
  type: z.literal('cta'),
  title: shortText(120).default(''),
  body: shortText(300).default(''),
  ...linkFields,
});

export const contactBlockSchema = z.object({
  ...blockBase,
  type: z.literal('contact'),
  title: shortText(80).default('Hubungi kami'),
  showWhatsapp: z.boolean().default(true),
  showPhone: z.boolean().default(true),
  showEmail: z.boolean().default(true),
  showAddress: z.boolean().default(true),
  showMap: z.boolean().default(true),
  note: shortText(500).default(''),
});

export const mapBlockSchema = z.object({
  ...blockBase,
  type: z.literal('map'),
  embedUrl: optionalUrl,
  height: z.enum(['sm', 'md', 'lg']).default('md'),
});

export const videoBlockSchema = z.object({
  ...blockBase,
  type: z.literal('video'),
  url: optionalUrl,
  caption: shortText(200).default(''),
});

export const statItemSchema = z.object({ id: z.string().min(1), value: shortText(20).min(1), label: shortText(60).default('') });

export const statsBlockSchema = z.object({
  ...blockBase,
  type: z.literal('stats'),
  items: z.array(statItemSchema).max(6).default([]),
});

const leafBlockSchemas = [
  heroBlockSchema,
  headingBlockSchema,
  textBlockSchema,
  imageBlockSchema,
  buttonBlockSchema,
  spacerBlockSchema,
  dividerBlockSchema,
  listingGridBlockSchema,
  listingSpotlightBlockSchema,
  galleryBlockSchema,
  faqBlockSchema,
  featuresBlockSchema,
  testimonialsBlockSchema,
  ctaBlockSchema,
  contactBlockSchema,
  mapBlockSchema,
  videoBlockSchema,
  statsBlockSchema,
] as const;

export const leafBlockSchema = z.discriminatedUnion('type', [...leafBlockSchemas]);
export type LeafBlock = z.infer<typeof leafBlockSchema>;

// ---------- container blocks ----------

/**
 * A group stacks leaf blocks vertically inside one styled frame (background colour or image,
 * padding, width). Combined with the shared style it lets owners build any custom section.
 */
export const groupBlockSchema = z.object({
  ...blockBase,
  type: z.literal('group'),
  children: z.array(leafBlockSchema).max(20).default([]),
  gap: z.enum(['sm', 'md', 'lg']).default('md'),
  /** Max width of the stacked content inside the frame. */
  contentWidth: z.enum(['narrow', 'default', 'wide']).default('default'),
  minHeight: z.enum(['auto', 'sm', 'md', 'lg', 'screen']).default('auto'),
  verticalAlign: z.enum(['top', 'center', 'bottom']).default('top'),
});
export type GroupBlock = z.infer<typeof groupBlockSchema>;

const columnChildSchema = z.discriminatedUnion('type', [...leafBlockSchemas, groupBlockSchema]);
export type ColumnChild = z.infer<typeof columnChildSchema>;

export const columnsBlockSchema = z.object({
  ...blockBase,
  type: z.literal('columns'),
  columns: z.array(z.array(columnChildSchema).max(20)).min(1).max(4),
  gap: z.enum(['sm', 'md', 'lg']).default('md'),
  verticalAlign: z.enum(['top', 'center', 'bottom']).default('top'),
  /** Optional column widths in fractions, e.g. [1, 2]; defaults to equal. */
  ratio: z.array(z.number().int().min(1).max(4)).max(4).default([]),
  /** Below this breakpoint the columns stack. */
  stackOn: z.enum(['sm', 'md', 'never']).default('md'),
});

export const blockSchema = z.discriminatedUnion('type', [...leafBlockSchemas, groupBlockSchema, columnsBlockSchema]);
export type Block = z.infer<typeof blockSchema>;
export type BlockType = Block['type'];
export type BlockOfType<T extends BlockType> = Extract<Block, { type: T }>;
export const CONTAINER_TYPES = ['group', 'columns'] as const;
export function isContainer(b: Block): b is GroupBlock | BlockOfType<'columns'> {
  return b.type === 'group' || b.type === 'columns';
}

export const BLOCK_TYPES = [
  'hero', 'heading', 'text', 'image', 'button', 'spacer', 'divider', 'group', 'columns',
  'listing_grid', 'listing_spotlight', 'gallery', 'faq', 'features', 'testimonials', 'cta', 'contact', 'map', 'video', 'stats',
] as const satisfies readonly BlockType[];

export type BlockCategory = 'layout' | 'content' | 'store' | 'marketing';

export const BLOCK_META: Record<BlockType, { label: string; description: string; category: BlockCategory }> = {
  hero: { label: 'Hero', description: 'Judul besar dengan gambar latar atau gambar samping, teks bebas, dan tombol.', category: 'marketing' },
  heading: { label: 'Judul', description: 'Judul bagian dengan keterangan singkat.', category: 'content' },
  text: { label: 'Teks', description: 'Paragraf dengan format, daftar, dan tautan.', category: 'content' },
  image: { label: 'Gambar', description: 'Satu gambar dengan keterangan.', category: 'content' },
  button: { label: 'Tombol', description: 'Satu atau beberapa tombol ke katalog, halaman, WhatsApp, atau URL.', category: 'content' },
  spacer: { label: 'Jarak', description: 'Ruang kosong vertikal.', category: 'layout' },
  divider: { label: 'Garis pemisah', description: 'Garis tipis antar bagian.', category: 'layout' },
  group: { label: 'Bagian bebas', description: 'Wadah dengan latar sendiri; isi dengan komponen apa saja.', category: 'layout' },
  columns: { label: 'Kolom', description: 'Satu sampai empat kolom berisi komponen lain.', category: 'layout' },
  listing_grid: { label: 'Daftar item', description: 'Item sewa dalam kisi, semua atau unggulan.', category: 'store' },
  listing_spotlight: { label: 'Sorotan item', description: 'Satu item dengan gambar besar dan tombol pesan.', category: 'store' },
  gallery: { label: 'Galeri', description: 'Kumpulan foto.', category: 'content' },
  faq: { label: 'FAQ', description: 'Pertanyaan yang sering ditanyakan.', category: 'marketing' },
  features: { label: 'Keunggulan', description: 'Daftar poin dengan ikon.', category: 'marketing' },
  testimonials: { label: 'Testimoni', description: 'Kutipan dari pelanggan.', category: 'marketing' },
  cta: { label: 'Ajakan', description: 'Blok ajakan dengan satu tombol.', category: 'marketing' },
  contact: { label: 'Kontak', description: 'WhatsApp, telepon, alamat, dan peta.', category: 'store' },
  map: { label: 'Peta', description: 'Peta Google Maps.', category: 'content' },
  video: { label: 'Video', description: 'Video YouTube.', category: 'content' },
  stats: { label: 'Angka', description: 'Angka penting dengan label.', category: 'marketing' },
};

// ---------- pages / site ----------

export const pageSeoSchema = z.object({
  title: shortText(70).default(''),
  description: shortText(200).default(''),
  noindex: z.boolean().default(false),
});

export const pageSchema = z.object({
  id: z.string().min(1),
  slug: z.string().trim().toLowerCase().min(1).max(80),
  title: shortText(120).default(''),
  seo: pageSeoSchema.prefault({}),
  blocks: z.array(blockSchema).max(60).default([]),
});
export type Page = z.infer<typeof pageSchema>;

export const siteConfigSchema = z.object({
  schemaVersion: z.literal(SITE_SCHEMA_VERSION).default(SITE_SCHEMA_VERSION),
  theme: themeSchema.prefault({}),
  nav: z.array(navItemSchema).max(12).default([]),
  footer: footerSchema.prefault({}),
  seo: seoSchema.prefault({}),
  pages: z.array(pageSchema).max(30).default([]),
});
export type SiteConfig = z.output<typeof siteConfigSchema>;
export type SiteConfigInput = z.input<typeof siteConfigSchema>;

/** Guarantees exactly one home page, first in the list. Call after parsing. */
export function normalizeSiteConfig(cfg: SiteConfig): SiteConfig {
  const home = cfg.pages.find((p) => p.slug === HOME_SLUG) ?? pageSchema.parse({ id: 'home', slug: HOME_SLUG, title: '' });
  const others = cfg.pages.filter((p) => p.slug !== HOME_SLUG);
  return { ...cfg, pages: [home, ...others] };
}

export function isPageSlugValid(slug: string): boolean {
  return SLUG_REGEX.test(slug) && !(RESERVED_PAGE_SLUGS as readonly string[]).includes(slug) && slug !== HOME_SLUG;
}

export function homePage(cfg: SiteConfig): Page {
  return cfg.pages.find((p) => p.slug === HOME_SLUG) ?? cfg.pages[0]!;
}

export function findPage(cfg: SiteConfig, slug: string): Page | undefined {
  return cfg.pages.find((p) => p.slug === slug);
}

// ---------- ids ----------

export function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
}

// ---------- defaults ----------

export function defaultBlock<T extends BlockType>(type: T): BlockOfType<T> {
  const base: Record<string, unknown> = { id: newId(), type };
  switch (type) {
    case 'columns':
      base.columns = [[defaultBlock('heading'), defaultBlock('text')], [defaultBlock('image')]];
      break;
    case 'features':
      base.items = [
        { id: newId(), icon: 'check', title: 'Unit terawat', body: 'Servis rutin sebelum disewakan.' },
        { id: newId(), icon: 'clock', title: 'Ambil kapan saja', body: 'Jam pengambilan fleksibel.' },
        { id: newId(), icon: 'wallet', title: 'Transfer bank', body: 'Bayar ke rekening kami, tanpa biaya tambahan.' },
      ];
      break;
    case 'faq':
      base.items = [{ id: newId(), question: 'Apa syarat sewanya?', answer: 'KTP dan deposit sesuai item.' }];
      break;
    case 'testimonials':
      base.items = [{ id: newId(), quote: 'Prosesnya cepat dan unitnya bersih.', name: 'Rani', meta: 'Sewa 3 hari' }];
      break;
    case 'stats':
      base.items = [
        { id: newId(), value: '5+', label: 'Tahun beroperasi' },
        { id: newId(), value: '1.000+', label: 'Penyewa' },
        { id: newId(), value: '4.9', label: 'Rating' },
      ];
      break;
    case 'heading':
      base.text = 'Judul bagian';
      break;
    case 'text':
      base.content = paragraphDoc('Tulis sesuatu di sini.');
      break;
    case 'cta':
      base.title = 'Siap menyewa?';
      base.ctaLabel = 'Lihat katalog';
      base.style = { background: 'primary', paddingY: 'lg', align: 'center' };
      break;
    case 'hero':
      base.title = 'Judul utama';
      base.subtitle = 'Satu kalimat tentang apa yang kamu sewakan.';
      base.buttons = [{ id: newId(), label: 'Lihat katalog', kind: 'catalog', target: '', variant: 'secondary' }];
      base.style = { paddingY: 'none', width: 'full' };
      break;
    case 'button':
      base.buttons = [{ id: newId(), label: 'Lihat katalog', kind: 'catalog', target: '', variant: 'primary' }];
      break;
    case 'group':
      base.children = [defaultBlock('heading'), defaultBlock('text'), defaultBlock('button')];
      base.style = { background: 'muted', paddingY: 'lg' };
      break;
    case 'image':
      base.ratio = '16:9';
      break;
    default:
      break;
  }
  return blockSchema.parse(base) as BlockOfType<T>;
}

export function defaultPage(slug: string, title: string): Page {
  return pageSchema.parse({ id: newId(), slug, title, blocks: [{ ...defaultBlock('heading'), text: title }, defaultBlock('text')] });
}

export function defaultSiteConfig(input: { tenantName: string; tagline?: string }): SiteConfig {
  return normalizeSiteConfig(siteConfigSchema.parse({
    theme: {},
    nav: [
      { id: newId(), label: 'Beranda', kind: 'home', target: '' },
      { id: newId(), label: 'Katalog', kind: 'catalog', target: '' },
      { id: newId(), label: 'Kontak', kind: 'block', target: 'contact' },
    ],
    seo: { title: input.tenantName, description: input.tagline ?? '' },
    footer: { text: `© ${new Date().getFullYear()} ${input.tenantName}` },
    pages: [
      {
        id: 'home',
        slug: HOME_SLUG,
        title: input.tenantName,
        blocks: [
          { id: 'hero', type: 'hero', title: input.tenantName, subtitle: input.tagline ?? '', buttons: [{ id: 'hero-cta', label: 'Lihat katalog', kind: 'catalog', target: '', variant: 'secondary' }], style: { paddingY: 'none', width: 'full' } },
          { id: 'featured', type: 'listing_grid', title: 'Unggulan', source: 'featured', limit: 4, columns: 4 },
          { id: 'catalog', type: 'listing_grid', title: 'Katalog', source: 'all', limit: 12, columns: 4, showSearch: true, showCategories: true, showViewAll: false },
          { id: 'contact', type: 'contact' },
        ],
      },
    ],
  }));
}

// ---------- tree helpers (used by the builder) ----------

/** Depth-first visit of every block on a page, including blocks inside groups and columns. */
export function walkBlocks(blocks: Block[], visit: (block: Block, parent: Block | null, index: number) => void, parent: Block | null = null): void {
  blocks.forEach((b, i) => {
    visit(b, parent, i);
    if (b.type === 'columns') b.columns.forEach((col) => walkBlocks(col, visit, b));
    if (b.type === 'group') walkBlocks(b.children, visit, b);
  });
}

export function findBlock(blocks: Block[], id: string): Block | undefined {
  let found: Block | undefined;
  walkBlocks(blocks, (b) => {
    if (!found && b.id === id) found = b;
  });
  return found;
}

/** Returns a new tree with the block replaced (or removed when `next` is null). */
export function replaceBlock(blocks: Block[], id: string, next: Block | null): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    if (b.id === id) {
      if (next) out.push(next);
      continue;
    }
    if (b.type === 'columns') out.push({ ...b, columns: b.columns.map((col) => replaceBlock(col, id, next) as ColumnChild[]) });
    else if (b.type === 'group') out.push({ ...b, children: replaceBlock(b.children, id, next) as LeafBlock[] });
    else out.push(b);
  }
  return out;
}

/** Assigns fresh ids to a block and everything inside it (used when duplicating). */
export function cloneBlock<T extends Block>(block: T): T {
  const cloned = { ...block, id: newId() } as T;
  if (cloned.type === 'columns') {
    return { ...cloned, columns: cloned.columns.map((col) => col.map((b) => cloneBlock(b))) } as T;
  }
  if (cloned.type === 'group') {
    return { ...cloned, children: cloned.children.map((b) => cloneBlock(b)) } as T;
  }
  return cloned;
}

/** Collects every block id on the page (for anchors and uniqueness checks). */
export function blockIds(blocks: Block[]): string[] {
  const ids: string[] = [];
  walkBlocks(blocks, (b) => ids.push(b.id));
  return ids;
}

// ---------- lenient parsing + migration ----------

/** Rewrites earlier v2 block shapes (single CTA fields, boolean overlay, single button) into the current one. */
export function upgradeBlock(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const b = { ...(raw as Record<string, unknown>) };
  if (b.type === 'hero') {
    if (!Array.isArray(b.buttons) && typeof b.ctaLabel === 'string' && b.ctaLabel) {
      b.buttons = [{ id: newId(), label: b.ctaLabel, kind: b.ctaKind ?? 'catalog', target: b.ctaTarget ?? '', variant: 'secondary' }];
    }
    if (typeof b.overlay === 'boolean') b.overlay = b.overlay ? 45 : 0;
    delete b.ctaLabel;
    delete b.ctaKind;
    delete b.ctaTarget;
  }
  if (b.type === 'button' && !Array.isArray(b.buttons) && typeof b.label === 'string') {
    b.buttons = [{ id: newId(), label: b.label || 'Tombol', kind: b.kind ?? 'catalog', target: b.target ?? '', variant: b.variant ?? 'primary' }];
    delete b.label;
    delete b.kind;
    delete b.target;
    delete b.variant;
  }
  return b;
}

function dropInvalidBlocks(raw: unknown[], allow: 'all' | 'column' | 'leaf' = 'all'): Block[] {
  const out: Block[] = [];
  for (const item of raw) {
    const b = upgradeBlock(item) as { type?: string; columns?: unknown; children?: unknown } | null;
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'columns') {
      if (allow !== 'all') continue;
      const cols = Array.isArray(b.columns) ? (b.columns as unknown[][]) : [];
      const cleaned = cols.map((col) => (Array.isArray(col) ? (dropInvalidBlocks(col, 'column') as ColumnChild[]) : []));
      const r = columnsBlockSchema.safeParse({ ...b, columns: cleaned.length >= 1 ? cleaned : [[]] });
      if (r.success) out.push(r.data);
      continue;
    }
    if (b.type === 'group') {
      if (allow === 'leaf') continue;
      const children = Array.isArray(b.children) ? (dropInvalidBlocks(b.children, 'leaf') as LeafBlock[]) : [];
      const r = groupBlockSchema.safeParse({ ...b, children });
      if (r.success) out.push(r.data);
      continue;
    }
    const r = leafBlockSchema.safeParse(b);
    if (r.success) out.push(r.data);
  }
  return out;
}

/**
 * Converts a version-1 config (`sections` on the home page) into version 2 pages/blocks.
 * `extraPages` lets the caller merge legacy rich-text pages stored elsewhere.
 */
export function migrateSiteConfig(input: unknown, extraPages: { slug: string; title: string; content: RichTextDoc; seo?: { title?: string; description?: string; noindex?: boolean } }[] = []): SiteConfigInput {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (obj.schemaVersion === SITE_SCHEMA_VERSION && Array.isArray(obj.pages)) return obj as SiteConfigInput;

  const sections = Array.isArray(obj.sections) ? (obj.sections as Record<string, unknown>[]) : [];
  const blocks: unknown[] = [];
  for (const s of sections) {
    const id = String(s.id ?? newId());
    const hidden = Boolean(s.hidden);
    switch (s.type) {
      case 'hero':
        blocks.push({ id, hidden, type: 'hero', title: s.title, subtitle: s.subtitle, imageUrl: s.imageUrl, overlay: s.overlay === false ? 0 : 45, buttons: s.ctaLabel ? [{ id: newId(), label: s.ctaLabel, kind: s.ctaKind ?? 'catalog', target: s.ctaTarget ?? '', variant: 'secondary' }] : [], style: { paddingY: 'none', width: 'full', align: s.align === 'center' ? 'center' : 'left' } });
        break;
      case 'featured_listings':
        blocks.push({ id, hidden, type: 'listing_grid', title: s.title, source: 'featured', limit: s.limit, columns: 4 });
        break;
      case 'catalog':
        blocks.push({ id, hidden, type: 'listing_grid', title: s.title, source: 'all', limit: s.limit, columns: 4, showSearch: s.showSearch, showCategories: s.showCategories, showViewAll: false });
        break;
      case 'about': {
        const textCol = [{ id: newId(), type: 'heading', text: s.title }, { id: newId(), type: 'text', content: s.content }];
        const imgCol = [{ id: newId(), type: 'image', url: s.imageUrl, ratio: '4:3' }];
        blocks.push({ id, hidden, type: 'columns', verticalAlign: 'center', columns: s.imagePosition === 'left' ? [imgCol, textCol] : [textCol, imgCol] });
        break;
      }
      case 'gallery':
        blocks.push({ id, hidden, type: 'gallery', title: s.title, images: s.images, columns: s.columns });
        break;
      case 'faq':
        blocks.push({ id, hidden, type: 'faq', title: s.title, items: s.items });
        break;
      case 'contact':
        blocks.push({ id, hidden, type: 'contact', title: s.title, showWhatsapp: s.showWhatsapp, showPhone: s.showPhone, showEmail: s.showEmail, showAddress: s.showAddress, showMap: s.showMap, note: s.note });
        break;
      case 'rich_text':
        blocks.push({ id, hidden, type: 'text', content: s.content, style: { width: s.width === 'wide' ? 'default' : 'narrow' } });
        break;
      default:
        break;
    }
  }
  const nav = Array.isArray(obj.nav) ? (obj.nav as Record<string, unknown>[]).map((n) => ({ ...n, kind: n.kind === 'section' ? 'block' : n.kind })) : [];
  const seo = (obj.seo ?? {}) as Record<string, unknown>;
  const pages: unknown[] = [{ id: 'home', slug: HOME_SLUG, title: String(seo.title ?? ''), blocks }];
  for (const p of extraPages) {
    pages.push({ id: newId(), slug: p.slug, title: p.title, seo: { title: p.seo?.title ?? '', description: p.seo?.description ?? '', noindex: p.seo?.noindex ?? false }, blocks: [{ id: newId(), type: 'text', content: p.content, style: { width: 'narrow' } }] });
  }
  return { schemaVersion: SITE_SCHEMA_VERSION, theme: obj.theme as SiteConfigInput['theme'], nav: nav as SiteConfigInput['nav'], footer: obj.footer as SiteConfigInput['footer'], seo: seo as SiteConfigInput['seo'], pages: pages as SiteConfigInput['pages'] };
}

/**
 * Lenient parse for renderers: migrates old versions and drops blocks that fail validation instead of
 * failing the whole page, so an older storefront deploy survives a newer admin.
 */
export function parseSiteConfigLenient(input: unknown): SiteConfig {
  const migrated = migrateSiteConfig(input) as Record<string, unknown>;
  const rawPages = Array.isArray(migrated.pages) ? (migrated.pages as Record<string, unknown>[]) : [];
  const pages = rawPages.map((p) => ({ ...p, blocks: dropInvalidBlocks(Array.isArray(p.blocks) ? p.blocks : []) }));
  const result = siteConfigSchema.safeParse({ ...migrated, pages });
  if (result.success) return normalizeSiteConfig(result.data);
  return normalizeSiteConfig(siteConfigSchema.parse({ pages }));
}
