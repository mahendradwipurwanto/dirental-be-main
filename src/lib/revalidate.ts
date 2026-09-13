import { waitUntil } from '@vercel/functions';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Tells rental-web to drop cached pages for the given tags. Fire-and-forget: runs after the
 * response via waitUntil, retries once, and the storefront's cacheLife is the fallback.
 */
export function revalidate(tags: string[]): void {
  if (tags.length === 0) return;
  const task = (async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`${env.WEB_URL}/api/revalidate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${env.REVALIDATE_SECRET}` },
          body: JSON.stringify({ tags }),
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) return;
        logger.warn({ status: res.status, tags }, 'revalidate: non-OK response');
      } catch (err) {
        logger.warn({ err, tags, attempt }, 'revalidate: request failed');
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
  waitUntil(task);
}

export const revalidateTenant = (slug: string) => revalidate([`tenant:${slug}`, `tenant:${slug}:listings`, 'directory']);
export const revalidateListings = (slug: string, listingSlug?: string) =>
  revalidate([`tenant:${slug}:listings`, ...(listingSlug ? [`listing:${slug}:${listingSlug}`] : []), 'directory']);
export const revalidateDirectory = () => revalidate(['directory']);
