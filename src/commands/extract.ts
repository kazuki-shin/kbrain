/**
 * gbrain extract — Extract links and timeline entries from brain markdown files.
 *
 * Subcommands:
 *   gbrain extract links [--dir <brain>] [--dry-run] [--json]
 *   gbrain extract timeline [--dir <brain>] [--dry-run] [--json]
 *   gbrain extract all [--dir <brain>] [--dry-run] [--json]
 */

import { readFileSync, readdirSync, lstatSync, existsSync } from 'fs';
import { join, relative, dirname } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { parseMarkdown } from '../core/markdown.ts';

// --- Types ---

export interface ExtractedLink {
  from_slug: string;
  to_slug: string;
  link_type: string;
  context: string;
}

export interface ExtractedTimelineEntry {
  slug: string;
  date: string;
  source: string;
  summary: string;
  detail?: string;
}

interface ExtractResult {
  links_created: number;
  timeline_entries_created: number;
  pages_processed: number;
}

// --- Shared walker ---

export function walkMarkdownFiles(dir: string): { path: string; relPath: string }[] {
  const files: { path: string; relPath: string }[] = [];
  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      if (entry.startsWith('.')) continue;
      const full = join(d, entry);
      try {
        if (lstatSync(full).isDirectory()) {
          walk(full);
        } else if (entry.endsWith('.md') && !entry.startsWith('_')) {
          files.push({ path: full, relPath: relative(dir, full) });
        }
      } catch { /* skip unreadable */ }
    }
  }
  walk(dir);
  return files;
}

// --- Link extraction ---

/** Extract markdown links to .md files (relative paths only) */
export function extractMarkdownLinks(content: string): { name: string; relTarget: string }[] {
  const results: { name: string; relTarget: string }[] = [];
  const pattern = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const target = match[2];
    if (target.includes('://')) continue; // skip external URLs
    results.push({ name: match[1], relTarget: target });
  }
  return results;
}

/** Extract Obsidian-style wiki-links: [[Page Name]] or [[Page Name|alias]] */
export function extractWikiLinks(content: string): { name: string; target: string }[] {
  const results: { name: string; target: string }[] = [];
  const pattern = /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const target = match[1].trim();
    const name = match[2]?.trim() || target;
    results.push({ name, target });
  }
  return results;
}

/**
 * Build a name→slug map from all vault files for wiki-link resolution.
 * Key = filename without extension (e.g. "Author - _avichawla").
 * Value = array of matching slugs (to detect ambiguity).
 */
export function buildNameToSlugMap(files: { relPath: string }[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const { relPath } of files) {
    const slug = relPath.replace(/\.md$/, '');
    const basename = slug.split('/').pop() ?? slug;
    const existing = map.get(basename);
    if (existing) {
      existing.push(slug);
    } else {
      map.set(basename, [slug]);
    }
  }
  return map;
}

/** Infer link type from directory structure */
function inferLinkType(fromDir: string, toDir: string, frontmatter?: Record<string, unknown>): string {
  const from = fromDir.split('/')[0];
  const to = toDir.split('/')[0];
  if (from === 'people' && to === 'companies') {
    if (Array.isArray(frontmatter?.founded)) return 'founded';
    return 'works_at';
  }
  if (from === 'people' && to === 'deals') return 'involved_in';
  if (from === 'deals' && to === 'companies') return 'deal_for';
  if (from === 'meetings' && to === 'people') return 'attendee';
  return 'mention';
}

/** Extract links from frontmatter fields.
 *  Handles both plain string slugs and {name, company, email} attendee objects. */
function extractFrontmatterLinks(slug: string, fm: Record<string, unknown>): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const fieldMap: Record<string, { dir: string; type: string }> = {
    company: { dir: 'companies', type: 'works_at' },
    companies: { dir: 'companies', type: 'works_at' },
    investors: { dir: 'companies', type: 'invested_in' },
    attendees: { dir: 'people', type: 'attendee' },
    founded: { dir: 'companies', type: 'founded' },
  };
  for (const [field, config] of Object.entries(fieldMap)) {
    const value = fm[field];
    if (!value) continue;
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      // Handle {name: "...", company: "...", email: "..."} objects (e.g. granola attendees)
      let nameStr: string;
      if (typeof item === 'object' && item !== null) {
        const obj = item as Record<string, unknown>;
        nameStr = (obj.name as string) || '';
      } else if (typeof item === 'string') {
        nameStr = item;
      } else {
        continue;
      }
      if (!nameStr) continue;
      const toSlug = `${config.dir}/${nameStr.toLowerCase().replace(/\s+/g, '-')}`;
      links.push({ from_slug: slug, to_slug: toSlug, link_type: config.type, context: `frontmatter.${field}` });
    }
  }
  return links;
}

/** Parse frontmatter using the project's gray-matter-based parser */
function parseFrontmatterFromContent(content: string, relPath: string): Record<string, unknown> {
  try {
    const parsed = parseMarkdown(content, relPath);
    return parsed.frontmatter;
  } catch {
    return {};
  }
}

/** Full link extraction from a single markdown file.
 *  Handles standard markdown links, wiki-links, and frontmatter fields.
 *  nameToSlug: optional map built by buildNameToSlugMap() for wiki-link resolution. */
export function extractLinksFromFile(
  content: string, relPath: string, allSlugs: Set<string>,
  nameToSlug?: Map<string, string[]>,
): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const slug = relPath.replace('.md', '');
  const fileDir = dirname(relPath);
  const fm = parseFrontmatterFromContent(content, relPath);

  // Standard markdown links: [text](path.md)
  for (const { name, relTarget } of extractMarkdownLinks(content)) {
    const resolved = join(fileDir, relTarget).replace('.md', '');
    if (allSlugs.has(resolved)) {
      links.push({
        from_slug: slug, to_slug: resolved,
        link_type: inferLinkType(fileDir, dirname(resolved), fm),
        context: `markdown link: [${name}]`,
      });
    }
  }

  // Wiki-links: [[Page Name|alias]]
  if (nameToSlug) {
    for (const { name, target } of extractWikiLinks(content)) {
      const matches = nameToSlug.get(target);
      if (!matches || matches.length !== 1) continue; // skip missing or ambiguous
      const toSlug = matches[0];
      if (toSlug === slug) continue; // skip self-links
      links.push({
        from_slug: slug, to_slug: toSlug,
        link_type: inferLinkType(fileDir, dirname(toSlug), fm),
        context: `wiki link: [[${name}]]`,
      });
    }
  }

  links.push(...extractFrontmatterLinks(slug, fm));
  return links;
}

// --- Timeline extraction ---

/**
 * Extract a timeline entry from frontmatter date + title.
 * Only fires for pages that are explicitly dated events:
 *   - Has both `date:` (YYYY-MM-DD) and `title:` (non-empty)
 *   - AND is a meeting/event type (type: meeting|event|call) OR lives in meetings/ or gdocs/
 * This avoids treating every author or source page with a `created:` date as a timeline event.
 *
 * Uses parseMarkdown directly so that `type` and `title` (stripped from cleanFrontmatter) are accessible.
 * Handles `date` as a JS Date object (YAML auto-conversion by gray-matter).
 */
export function extractTimelineFromFrontmatter(content: string, slug: string): ExtractedTimelineEntry[] {
  try {
    const parsed = parseMarkdown(content, slug + '.md');
    const { title, type: pageType, frontmatter: fm } = parsed;

    if (!title) return [];

    // date may be a JS Date object (YAML auto-converts bare date scalars)
    const rawDate = fm.date;
    if (!rawDate) return [];
    let dateStr: string;
    if (rawDate instanceof Date) {
      dateStr = rawDate.toISOString().slice(0, 10);
    } else {
      const s = String(rawDate);
      if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return [];
      dateStr = s.slice(0, 10);
    }

    const type = (pageType ?? '').toLowerCase();
    const topDir = slug.split('/')[0];
    const isEventType = ['meeting', 'event', 'call'].includes(type);
    const isEventDir = ['meetings', 'gdocs'].includes(topDir);
    if (!isEventType && !isEventDir) return [];

    const source = (fm.source as string | undefined) || type || 'frontmatter';
    return [{ slug, date: dateStr, source, summary: title }];
  } catch {
    return [];
  }
}

/** Extract timeline entries from markdown content */
export function extractTimelineFromContent(content: string, slug: string): ExtractedTimelineEntry[] {
  const entries: ExtractedTimelineEntry[] = [];

  // Format 1: Bullet — - **YYYY-MM-DD** | Source — Summary
  const bulletPattern = /^-\s+\*\*(\d{4}-\d{2}-\d{2})\*\*\s*\|\s*(.+?)\s*[—–-]\s*(.+)$/gm;
  let match;
  while ((match = bulletPattern.exec(content)) !== null) {
    entries.push({ slug, date: match[1], source: match[2].trim(), summary: match[3].trim() });
  }

  // Format 2: Header — ### YYYY-MM-DD — Title
  const headerPattern = /^###\s+(\d{4}-\d{2}-\d{2})\s*[—–-]\s*(.+)$/gm;
  while ((match = headerPattern.exec(content)) !== null) {
    const afterIdx = match.index + match[0].length;
    const nextHeader = content.indexOf('\n### ', afterIdx);
    const nextSection = content.indexOf('\n## ', afterIdx);
    const endIdx = Math.min(
      nextHeader >= 0 ? nextHeader : content.length,
      nextSection >= 0 ? nextSection : content.length,
    );
    const detail = content.slice(afterIdx, endIdx).trim();
    entries.push({ slug, date: match[1], source: 'markdown', summary: match[2].trim(), detail: detail || undefined });
  }

  return entries;
}

// --- Main command ---

export async function runExtract(engine: BrainEngine, args: string[]) {
  const subcommand = args[0];
  const dirIdx = args.indexOf('--dir');
  const brainDir = (dirIdx >= 0 && dirIdx + 1 < args.length) ? args[dirIdx + 1] : '.';
  const dryRun = args.includes('--dry-run');
  const jsonMode = args.includes('--json');

  if (!subcommand || !['links', 'timeline', 'all'].includes(subcommand)) {
    console.error('Usage: gbrain extract <links|timeline|all> [--dir <brain-dir>] [--dry-run] [--json]');
    process.exit(1);
  }

  if (!existsSync(brainDir)) {
    console.error(`Directory not found: ${brainDir}`);
    process.exit(1);
  }

  const result: ExtractResult = { links_created: 0, timeline_entries_created: 0, pages_processed: 0 };

  if (subcommand === 'links' || subcommand === 'all') {
    const r = await extractLinksFromDir(engine, brainDir, dryRun, jsonMode);
    result.links_created = r.created;
    result.pages_processed = r.pages;
  }
  if (subcommand === 'timeline' || subcommand === 'all') {
    const r = await extractTimelineFromDir(engine, brainDir, dryRun, jsonMode);
    result.timeline_entries_created = r.created;
    result.pages_processed = Math.max(result.pages_processed, r.pages);
  }

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!dryRun) {
    console.log(`\nDone: ${result.links_created} links, ${result.timeline_entries_created} timeline entries from ${result.pages_processed} pages`);
  }
}

async function extractLinksFromDir(
  engine: BrainEngine, brainDir: string, dryRun: boolean, jsonMode: boolean,
): Promise<{ created: number; pages: number }> {
  const files = walkMarkdownFiles(brainDir);
  const allSlugs = new Set(files.map(f => f.relPath.replace('.md', '')));
  const nameToSlug = buildNameToSlugMap(files);

  // Load existing links for O(1) dedup
  const existing = new Set<string>();
  try {
    const pages = await engine.listPages({ limit: 100000 });
    for (const page of pages) {
      for (const link of await engine.getLinks(page.slug)) {
        existing.add(`${link.from_slug}::${link.to_slug}`);
      }
    }
  } catch { /* fresh brain */ }

  let created = 0;
  for (let i = 0; i < files.length; i++) {
    try {
      const content = readFileSync(files[i].path, 'utf-8');
      const links = extractLinksFromFile(content, files[i].relPath, allSlugs, nameToSlug);
      for (const link of links) {
        const key = `${link.from_slug}::${link.to_slug}`;
        if (existing.has(key)) continue;
        existing.add(key);
        if (dryRun) {
          if (!jsonMode) console.log(`  ${link.from_slug} → ${link.to_slug} (${link.link_type})`);
          created++;
        } else {
          try {
            await engine.addLink(link.from_slug, link.to_slug, link.context, link.link_type);
            created++;
          } catch { /* UNIQUE or page not found */ }
        }
      }
    } catch { /* skip unreadable */ }
    if (jsonMode && !dryRun && (i % 100 === 0 || i === files.length - 1)) {
      process.stderr.write(JSON.stringify({ event: 'progress', phase: 'extracting_links', done: i + 1, total: files.length }) + '\n');
    }
  }

  if (!jsonMode) {
    const label = dryRun ? '(dry run) would create' : 'created';
    console.log(`Links: ${label} ${created} from ${files.length} pages`);
  }
  return { created, pages: files.length };
}

async function extractTimelineFromDir(
  engine: BrainEngine, brainDir: string, dryRun: boolean, jsonMode: boolean,
): Promise<{ created: number; pages: number }> {
  const files = walkMarkdownFiles(brainDir);

  // Load existing timeline entries for O(1) dedup
  const existing = new Set<string>();
  try {
    const pages = await engine.listPages({ limit: 100000 });
    for (const page of pages) {
      for (const entry of await engine.getTimeline(page.slug)) {
        existing.add(`${page.slug}::${entry.date}::${entry.summary}`);
      }
    }
  } catch { /* fresh brain */ }

  let created = 0;
  for (let i = 0; i < files.length; i++) {
    try {
      const content = readFileSync(files[i].path, 'utf-8');
      const slug = files[i].relPath.replace('.md', '');
      // Combine inline timeline markers + frontmatter-date events
      const entries = [
        ...extractTimelineFromContent(content, slug),
        ...extractTimelineFromFrontmatter(content, slug),
      ];
      for (const entry of entries) {
        const key = `${entry.slug}::${entry.date}::${entry.summary}`;
        if (existing.has(key)) continue;
        existing.add(key);
        if (dryRun) {
          if (!jsonMode) console.log(`  ${entry.slug}: ${entry.date} — ${entry.summary}`);
          created++;
        } else {
          try {
            await engine.addTimelineEntry(entry.slug, { date: entry.date, source: entry.source, summary: entry.summary, detail: entry.detail });
            created++;
          } catch { /* page not in DB or constraint */ }
        }
      }
    } catch { /* skip unreadable */ }
    if (jsonMode && !dryRun && (i % 100 === 0 || i === files.length - 1)) {
      process.stderr.write(JSON.stringify({ event: 'progress', phase: 'extracting_timeline', done: i + 1, total: files.length }) + '\n');
    }
  }

  if (!jsonMode) {
    const label = dryRun ? '(dry run) would create' : 'created';
    console.log(`Timeline: ${label} ${created} entries from ${files.length} pages`);
  }
  return { created, pages: files.length };
}

// --- Sync integration hooks ---

export async function extractLinksForSlugs(engine: BrainEngine, repoPath: string, slugs: string[]): Promise<number> {
  const allFiles = walkMarkdownFiles(repoPath);
  const allSlugs = new Set(allFiles.map(f => f.relPath.replace('.md', '')));
  const nameToSlug = buildNameToSlugMap(allFiles);
  let created = 0;
  for (const slug of slugs) {
    const filePath = join(repoPath, slug + '.md');
    if (!existsSync(filePath)) continue;
    try {
      const content = readFileSync(filePath, 'utf-8');
      for (const link of extractLinksFromFile(content, slug + '.md', allSlugs, nameToSlug)) {
        try { await engine.addLink(link.from_slug, link.to_slug, link.context, link.link_type); created++; } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return created;
}

export async function extractTimelineForSlugs(engine: BrainEngine, repoPath: string, slugs: string[]): Promise<number> {
  let created = 0;
  for (const slug of slugs) {
    const filePath = join(repoPath, slug + '.md');
    if (!existsSync(filePath)) continue;
    try {
      const content = readFileSync(filePath, 'utf-8');
      const entries = [
        ...extractTimelineFromContent(content, slug),
        ...extractTimelineFromFrontmatter(content, slug),
      ];
      for (const entry of entries) {
        try { await engine.addTimelineEntry(entry.slug, { date: entry.date, source: entry.source, summary: entry.summary, detail: entry.detail }); created++; } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return created;
}
