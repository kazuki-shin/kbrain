import { join, basename } from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import type { BrainEngine } from '../core/engine.ts';

const COMPILE_START = '<!-- gbrain:compile:start -->';
const COMPILE_END = '<!-- gbrain:compile:end -->';
const CONNECTIONS_HEADER = '## Connections';

/** Human-readable label for each link_type */
const LINK_TYPE_LABELS: Record<string, string> = {
  works_at: 'Works at',
  attendee: 'Attendees',
  invested_in: 'Investors',
  deal_for: 'Company',
  references: 'References',
  related: 'Related',
};

function labelFor(linkType: string): string {
  return LINK_TYPE_LABELS[linkType] ?? linkType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/** Build the managed connections block from a map of linkType → target basenames. */
function buildConnectionsBlock(grouped: Map<string, string[]>): string {
  const lines: string[] = [COMPILE_START];
  for (const [linkType, targets] of grouped) {
    const label = labelFor(linkType);
    const wikilinks = targets.map(t => `[[${t}]]`).join(', ');
    lines.push(`**${label}:** ${wikilinks}`);
  }
  lines.push(COMPILE_END);
  return lines.join('\n');
}

/** Replace or inject the managed connections section in the file content. */
function applyConnectionsBlock(content: string, grouped: Map<string, string[]>): string {
  const block = buildConnectionsBlock(grouped);

  const startIdx = content.indexOf(COMPILE_START);
  const endIdx = content.indexOf(COMPILE_END);

  if (startIdx >= 0 && endIdx >= 0 && endIdx > startIdx) {
    // Replace existing managed block
    return content.slice(0, startIdx) + block + content.slice(endIdx + COMPILE_END.length);
  }

  // Look for ## Connections header to insert after
  const headerIdx = content.indexOf(CONNECTIONS_HEADER);
  if (headerIdx >= 0) {
    // Insert block right after the header line
    const afterHeader = content.indexOf('\n', headerIdx);
    if (afterHeader >= 0) {
      return (
        content.slice(0, afterHeader + 1) +
        '\n' +
        block +
        '\n' +
        content.slice(afterHeader + 1)
      );
    }
  }

  // Append new section at end of file
  const trimmed = content.trimEnd();
  return trimmed + '\n\n' + CONNECTIONS_HEADER + '\n\n' + block + '\n';
}

/** Remove the managed connections section (used when there are no frontmatter links). */
function removeConnectionsBlock(content: string): string {
  const startIdx = content.indexOf(COMPILE_START);
  const endIdx = content.indexOf(COMPILE_END);

  if (startIdx < 0 || endIdx < 0) return content;

  // Also remove the ## Connections header if it immediately precedes the block
  let removeFrom = startIdx;
  const headerCandidate = content.lastIndexOf(CONNECTIONS_HEADER, startIdx);
  if (
    headerCandidate >= 0 &&
    content.slice(headerCandidate, startIdx).trim() === CONNECTIONS_HEADER
  ) {
    // Include any whitespace before the header
    const beforeHeader = content.lastIndexOf('\n\n', headerCandidate);
    if (beforeHeader >= 0) removeFrom = beforeHeader;
    else removeFrom = headerCandidate;
  }

  const removeUntil = endIdx + COMPILE_END.length;
  return (content.slice(0, removeFrom) + content.slice(removeUntil)).trimEnd() + '\n';
}

export interface CompileResult {
  pagesUpdated: number;
  pagesCleared: number;
  linksWritten: number;
}

/**
 * Run compile for specific slugs (autopilot incremental mode) or all pages (standalone).
 *
 * @param engine     Brain engine
 * @param repoPath   Vault root directory
 * @param slugFilter If provided, only compile these slugs. If empty/undefined, compile all pages.
 * @param dryRun     Log changes but don't write files
 */
export async function runCompile(
  engine: BrainEngine,
  args: string[],
  slugFilter?: string[],
): Promise<CompileResult> {
  const repoIdx = args.indexOf('--repo');
  const repoPath = repoIdx >= 0 ? args[repoIdx + 1] : process.cwd();
  const dryRun = args.includes('--dry-run');
  const verbose = args.includes('--verbose');

  // Determine which slugs to process
  let slugs: string[];
  if (slugFilter && slugFilter.length > 0) {
    slugs = slugFilter;
  } else {
    const pages = await engine.listPages();
    slugs = pages.map(p => p.slug);
  }

  let pagesUpdated = 0;
  let pagesCleared = 0;
  let linksWritten = 0;

  for (const slug of slugs) {
    const vaultPath = join(repoPath, slug + '.md');
    if (!existsSync(vaultPath)) continue;

    // Get frontmatter-derived links for this page
    const links = await engine.getLinks(slug);
    const frontmatterLinks = links.filter(l => l.context?.startsWith('frontmatter'));

    let content: string;
    try {
      content = readFileSync(vaultPath, 'utf-8');
    } catch {
      continue;
    }

    if (frontmatterLinks.length === 0) {
      // Remove any existing managed block (DB says no frontmatter links → clean up)
      if (content.includes(COMPILE_START)) {
        const cleaned = removeConnectionsBlock(content);
        if (!dryRun) writeFileSync(vaultPath, cleaned, 'utf-8');
        pagesCleared++;
        if (verbose) console.log(`[compile] ${slug}: removed stale connections block`);
      }
      continue;
    }

    // Group by link_type, dedup target basenames per type
    const grouped = new Map<string, Set<string>>();
    for (const link of frontmatterLinks) {
      const targetName = basename(link.to_slug);
      if (!grouped.has(link.link_type)) grouped.set(link.link_type, new Set());
      grouped.get(link.link_type)!.add(targetName);
    }

    // Convert Sets to sorted arrays
    const sortedGrouped = new Map<string, string[]>();
    for (const [k, v] of grouped) {
      sortedGrouped.set(k, Array.from(v).sort());
    }

    // Build what the block should look like
    const desiredBlock = buildConnectionsBlock(sortedGrouped);

    // Check if the file already has this exact block (idempotent)
    const startIdx = content.indexOf(COMPILE_START);
    const endIdx = content.indexOf(COMPILE_END);
    if (startIdx >= 0 && endIdx >= 0) {
      const existingBlock = content.slice(startIdx, endIdx + COMPILE_END.length);
      if (existingBlock === desiredBlock) {
        // Already up to date
        continue;
      }
    }

    const newContent = applyConnectionsBlock(content, sortedGrouped);

    if (!dryRun) {
      writeFileSync(vaultPath, newContent, 'utf-8');
    }

    pagesUpdated++;
    linksWritten += frontmatterLinks.length;

    const summary = Array.from(sortedGrouped.entries())
      .map(([k, v]) => `${k}: ${v.join(', ')}`)
      .join(' | ');
    console.log(`[compile] ${slug}: +${frontmatterLinks.length} links (${summary})${dryRun ? ' [dry-run]' : ''}`);
  }

  if (!slugFilter) {
    // Only print summary for standalone (not autopilot incremental)
    console.log(`[compile] done. ${pagesUpdated} pages updated, ${pagesCleared} cleared, ${linksWritten} links written.`);
  }

  return { pagesUpdated, pagesCleared, linksWritten };
}
