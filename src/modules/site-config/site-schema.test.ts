import { describe, expect, it } from 'vitest';
import {
  blockIds,
  cloneBlock,
  defaultBlock,
  defaultSiteConfig,
  findBlock,
  homePage,
  migrateSiteConfig,
  parseSiteConfigLenient,
  replaceBlock,
  siteConfigSchema,
  upgradeBlock,
  type Block,
} from './site-schema.js';

describe('site schema v2', () => {
  it('builds a default site with a home page first', () => {
    const cfg = defaultSiteConfig({ tenantName: 'Toko A', tagline: 'Sewa motor' });
    expect(cfg.schemaVersion).toBe(2);
    expect(cfg.pages[0]?.slug).toBe('home');
    expect(homePage(cfg).blocks.map((b) => b.type)).toEqual(['hero', 'listing_grid', 'listing_grid', 'contact']);
    expect(cfg.theme.fontFamily).toBe('plus-jakarta-sans');
  });

  it('migrates a v1 sections config into blocks and merges legacy pages', () => {
    const v1 = {
      schemaVersion: 1,
      theme: { primary: '#ff0000' },
      nav: [{ id: 'n1', label: 'Kontak', kind: 'section', target: 'contact' }],
      sections: [
        { id: 'hero', type: 'hero', title: 'Halo', subtitle: 'Sub', align: 'center' },
        { id: 'about', type: 'about', title: 'Tentang', content: { type: 'doc', content: [] }, imageUrl: 'https://x.test/a.jpg', imagePosition: 'left' },
        { id: 'faq1', type: 'faq', title: 'FAQ', items: [{ id: 'q', question: 'A?', answer: 'B' }] },
        { id: 'bad', type: 'unknown' },
      ],
      seo: { title: 'Toko' },
    };
    const cfg = parseSiteConfigLenient(migrateSiteConfig(v1, [{ slug: 'syarat', title: 'Syarat', content: { type: 'doc', content: [] } }]));
    expect(cfg.theme.primary).toBe('#ff0000');
    expect(cfg.nav[0]?.kind).toBe('block');
    const home = homePage(cfg);
    expect(home.blocks.map((b) => b.type)).toEqual(['hero', 'columns', 'faq']);
    const cols = home.blocks[1];
    expect(cols?.type === 'columns' && cols.columns[0]?.[0]?.type).toBe('image');
    expect(cfg.pages[1]?.slug).toBe('syarat');
    expect(cfg.pages[1]?.blocks[0]?.type).toBe('text');
  });

  it('upgrades earlier v2 shapes: single CTA fields become buttons, boolean overlay becomes a percentage', () => {
    const hero = upgradeBlock({ id: 'h', type: 'hero', title: 'Hi', ctaLabel: 'Go', ctaKind: 'page', ctaTarget: 'about', overlay: false }) as Record<string, unknown>;
    expect(hero.buttons).toEqual([expect.objectContaining({ label: 'Go', kind: 'page', target: 'about' })]);
    expect(hero.overlay).toBe(0);
    expect('ctaLabel' in hero).toBe(false);
    const btn = upgradeBlock({ id: 'b', type: 'button', label: 'Pesan', kind: 'whatsapp', variant: 'outline' }) as Record<string, unknown>;
    expect(btn.buttons).toEqual([expect.objectContaining({ label: 'Pesan', kind: 'whatsapp', variant: 'outline' })]);
    const cfg = parseSiteConfigLenient({ schemaVersion: 2, pages: [{ id: 'home', slug: 'home', blocks: [{ id: 'h', type: 'hero', ctaLabel: 'Go' }, { id: 'b', type: 'button', label: 'X' }] }] });
    const [h, b] = homePage(cfg).blocks;
    expect(h?.type === 'hero' && h.buttons.length).toBe(1);
    expect(b?.type === 'button' && b.buttons.length).toBe(1);
  });

  it('nests groups inside columns but keeps groups to leaf children', () => {
    const group = defaultBlock('group');
    expect(group.children.map((c) => c.type)).toEqual(['heading', 'text', 'button']);
    const cfg = parseSiteConfigLenient({
      schemaVersion: 2,
      pages: [{ id: 'home', slug: 'home', blocks: [{ id: 'c', type: 'columns', columns: [[group], [{ id: 'g2', type: 'group', children: [{ id: 'x', type: 'columns', columns: [[]] }, { id: 't', type: 'text' }] }]] }] }],
    });
    const cols = homePage(cfg).blocks[0];
    expect(cols?.type).toBe('columns');
    if (cols?.type === 'columns') {
      expect(cols.columns[0]?.[0]?.type).toBe('group');
      const g2 = cols.columns[1]?.[0];
      expect(g2?.type === 'group' && g2.children.map((c) => c.type)).toEqual(['text']);
    }
    expect(blockIds(homePage(cfg).blocks)).toContain('t');
  });

  it('drops invalid blocks leniently but rejects them strictly', () => {
    const cfg = parseSiteConfigLenient({ schemaVersion: 2, pages: [{ id: 'home', slug: 'home', blocks: [{ id: 'x', type: 'nope' }, { id: 'y', type: 'divider' }] }] });
    expect(homePage(cfg).blocks.map((b) => b.type)).toEqual(['divider']);
    expect(siteConfigSchema.safeParse({ schemaVersion: 2, pages: [{ id: 'home', slug: 'home', blocks: [{ id: 'x', type: 'nope' }] }] }).success).toBe(false);
  });

  it('tree helpers find, replace and clone nested blocks', () => {
    const columns = defaultBlock('columns');
    const inner = columns.columns[0]![0]!;
    const blocks: Block[] = [defaultBlock('hero'), columns];
    expect(findBlock(blocks, inner.id)?.type).toBe('heading');
    const replaced = replaceBlock(blocks, inner.id, { ...inner, type: 'heading', text: 'Changed' } as Block);
    const found = findBlock(replaced, inner.id);
    expect(found?.type === 'heading' && found.text).toBe('Changed');
    expect(findBlock(replaceBlock(blocks, inner.id, null), inner.id)).toBeUndefined();
    const cloned = cloneBlock(columns);
    expect(cloned.id).not.toBe(columns.id);
    expect(new Set([...blockIds([columns]), ...blockIds([cloned])]).size).toBe(blockIds([columns]).length * 2);
  });
});
