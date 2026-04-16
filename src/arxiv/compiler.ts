import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serializeMarkdown } from '../core/markdown.ts';
import { slugifySegment } from '../core/sync.ts';
import type { ArxivPaper } from './api.ts';
import type { PaperSummary } from './summary.ts';

export interface RelatedBrainPage {
  slug: string;
  title: string;
  type: string;
}

export interface PreparedPaper {
  metadata: ArxivPaper;
  extractedText: string;
  pageCount: number;
  truncated: boolean;
  pdfPath: string;
  metadataPath: string;
  textPath: string;
  summary: PaperSummary;
  relatedPages: RelatedBrainPage[];
}

export interface DatasetMeta {
  id: string;
  title: string;
  description: string;
}

export interface CompileArxivOptions {
  dataset: DatasetMeta;
  papers: PreparedPaper[];
  outputDir: string;
  generatedAt?: string;
  cleanOutput?: boolean;
  createCollection?: boolean;
  existingAuthorSlugs?: Set<string>;
}

export interface CompiledPage {
  path: string;
  content: string;
}

export interface CompileArxivResult {
  outputDir: string;
  pages: string[];
  pageCount: number;
  paperPages: number;
  authorPages: number;
  collectionPages: number;
  existingAuthorLinks: string[];
  paperSlugs: string[];
}

export async function compileArxivPapers(opts: CompileArxivOptions): Promise<CompileArxivResult> {
  const pages = buildArxivPages(opts);

  if (opts.cleanOutput !== false) {
    await rm(opts.outputDir, { recursive: true, force: true });
  }
  await mkdir(opts.outputDir, { recursive: true });

  const written: string[] = [];
  for (const page of pages.pages) {
    const fullPath = path.join(opts.outputDir, page.path);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, page.content, 'utf-8');
    written.push(fullPath);
  }

  return {
    outputDir: path.resolve(opts.outputDir),
    pages: written,
    pageCount: pages.pages.length,
    paperPages: pages.paperSlugs.length,
    authorPages: pages.authorPaths.length,
    collectionPages: pages.collectionPaths.length,
    existingAuthorLinks: pages.existingAuthorSlugs,
    paperSlugs: pages.paperSlugs,
  };
}

export function buildArxivPages(opts: CompileArxivOptions): {
  pages: CompiledPage[];
  paperSlugs: string[];
  authorPaths: string[];
  collectionPaths: string[];
  existingAuthorSlugs: string[];
} {
  const generatedAt = opts.generatedAt ?? new Date().toISOString().slice(0, 10);
  const existingAuthorSlugs = opts.existingAuthorSlugs ?? new Set<string>();
  const pages: CompiledPage[] = [];
  const paperSlugs: string[] = [];
  const authorGroups = new Map<string, { name: string; papers: PreparedPaper[] }>();
  const skippedAuthorSlugs = new Set<string>();

  for (const paper of opts.papers) {
    const paperPath = paperPathForPaper(paper.metadata);
    const paperSlug = paperPath.replace(/\.md$/, '');
    paperSlugs.push(paperSlug);

    const authorLinks = paper.metadata.authors.map((author) => {
      const slug = slugForAuthor(author);
      const authorPath = `${slug}.md`;
      if (!authorGroups.has(slug)) {
        authorGroups.set(slug, { name: author, papers: [] });
      }
      authorGroups.get(slug)!.papers.push(paper);
      if (existingAuthorSlugs.has(slug)) {
        skippedAuthorSlugs.add(slug);
      }
      return {
        name: author,
        slug,
        href: relativeMarkdownLink(paperPath, authorPath, author),
      };
    });

    const relatedLinks = paper.relatedPages.map((related) => ({
      ...related,
      href: relativeMarkdownLink(paperPath, `${related.slug}.md`, related.title),
    }));

    const frontmatter = cleanFrontmatter({
      source_type: 'arxiv',
      arxiv_id: paper.metadata.arxivId,
      arxiv_version: paper.metadata.version ?? undefined,
      arxiv_versioned_id: paper.metadata.versionedId,
      authors: paper.metadata.authors,
      date: isoDate(paper.metadata.published),
      updated: isoDate(paper.metadata.updated),
      categories: paper.metadata.categories,
      primary_category: paper.metadata.primaryCategory ?? undefined,
      abstract: paper.metadata.abstract,
      source_url: paper.metadata.absUrl,
      pdf_url: paper.metadata.pdfUrl,
      raw_pdf: paper.pdfPath,
      raw_metadata: paper.metadataPath,
      raw_text: paper.textPath,
      page_count: paper.pageCount,
      text_truncated: paper.truncated || undefined,
      summary_source: paper.summary.summarySource,
      tags: [
        'arxiv-paper',
        ...(paper.metadata.categories.slice(0, 4).map((category) => `arxiv/${category.toLowerCase()}`)),
      ],
    });

    const compiledTruth = [
      `# ${paper.metadata.title}`,
      '',
      `${paper.summary.contributionSummary} [Source: ArXiv, ${paper.metadata.absUrl}]`,
      '',
      '## Metadata',
      `- ArXiv ID: ${paper.metadata.versionedId}. [Source: ArXiv, ${paper.metadata.absUrl}]`,
      `- Published: ${isoDate(paper.metadata.published) || 'unknown'}. [Source: ArXiv, ${paper.metadata.absUrl}]`,
      ...(paper.metadata.primaryCategory
        ? [`- Primary category: ${paper.metadata.primaryCategory}. [Source: ArXiv, ${paper.metadata.absUrl}]`]
        : []),
      ...(paper.metadata.categories.length > 0
        ? [`- Categories: ${paper.metadata.categories.join(', ')}. [Source: ArXiv, ${paper.metadata.absUrl}]`]
        : []),
      '',
      '## Authors',
      ...authorLinks.map((author) => `- ${author.href}. [Source: ArXiv, ${paper.metadata.absUrl}]`),
      '',
      '## Abstract',
      `${paper.metadata.abstract} [Source: ArXiv, ${paper.metadata.absUrl}]`,
      '',
      '## Key Findings',
      ...paper.summary.keyFindings.map((finding) => `- ${finding} [Source: ArXiv, ${paper.metadata.absUrl}]`),
      '',
      '## Why It Matters',
      `${paper.summary.relevanceSummary} [Source: compiled from ArXiv metadata and extracted PDF text, ${generatedAt}]`,
      '',
      '## Related Brain Pages',
      ...(relatedLinks.length > 0
        ? relatedLinks.map((link) => `- ${link.href} (${link.type}). [Source: related brain page match, ${generatedAt}]`)
        : ['- No deterministic related-page matches were found during import prep. [Source: related brain page match, none]']),
      '',
      '## Provenance',
      `- [ArXiv abstract page](${paper.metadata.absUrl})`,
      `- [PDF](${paper.metadata.pdfUrl})`,
      `- Raw metadata JSON: \`${paper.metadataPath}\``,
      `- Raw extracted text: \`${paper.textPath}\``,
      '',
      '## Paper Text',
      paper.extractedText || '_PDF text extraction returned no text._',
    ].join('\n');

    const timeline = [
      '## Timeline',
      '',
      `- **${isoDate(paper.metadata.published) || generatedAt}** | ArXiv publication — ${paper.metadata.title}. [Source: ArXiv, ${paper.metadata.absUrl}]`,
      ...(paper.metadata.updated && isoDate(paper.metadata.updated) !== isoDate(paper.metadata.published)
        ? [`- **${isoDate(paper.metadata.updated)}** | ArXiv update — metadata updated for ${paper.metadata.versionedId}. [Source: ArXiv, ${paper.metadata.absUrl}]`]
        : []),
    ].join('\n');

    pages.push({
      path: paperPath,
      content: serializeMarkdown(frontmatter, compiledTruth, timeline, {
        type: 'source',
        title: paper.metadata.title,
        tags: frontmatter.tags,
      }),
    });
  }

  const authorPaths: string[] = [];
  for (const [slug, author] of [...authorGroups.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    if (existingAuthorSlugs.has(slug)) continue;
    const filePath = `${slug}.md`;
    authorPaths.push(filePath);

    const frontmatter = cleanFrontmatter({
      arxiv_author: true,
      papers: author.papers.map((paper) => paper.metadata.versionedId),
      first_seen: generatedAt,
      tags: ['arxiv-author'],
    });

    const compiledTruth = [
      `# ${author.name}`,
      '',
      `${author.name} appears as an author on ${author.papers.length} ArXiv paper${author.papers.length === 1 ? '' : 's'} ingested into the brain. [Source: compiled from ArXiv metadata, ${generatedAt}]`,
      '',
      '## Papers',
      ...author.papers
        .sort((a, b) => a.metadata.title.localeCompare(b.metadata.title))
        .map((paper) => {
          const paperPath = paperPathForPaper(paper.metadata);
          return `- ${relativeMarkdownLink(filePath, paperPath, paper.metadata.title)}. [Source: ArXiv, ${paper.metadata.absUrl}]`;
        }),
      '',
      '## Notes',
      '- Author page created from ArXiv metadata. Expand with affiliations, prior work, and domain context when the person becomes strategically relevant. [Source: compiled from ArXiv metadata]',
    ].join('\n');

    const timeline = [
      '## Timeline',
      '',
      ...author.papers.map((paper) =>
        `- **${isoDate(paper.metadata.published) || generatedAt}** | ArXiv paper — ${relativeMarkdownLink(filePath, paperPathForPaper(paper.metadata), paper.metadata.title)}. [Source: ArXiv, ${paper.metadata.absUrl}]`,
      ),
    ].join('\n');

    pages.push({
      path: filePath,
      content: serializeMarkdown(frontmatter, compiledTruth, timeline, {
        type: 'person',
        title: author.name,
        tags: frontmatter.tags,
      }),
    });
  }

  const collectionPaths: string[] = [];
  if (opts.createCollection !== false) {
    const collectionPath = `collections/${slugifySegment(opts.dataset.title || opts.dataset.id)}.md`;
    collectionPaths.push(collectionPath);
    const categoryCounts = new Map<string, number>();
    for (const paper of opts.papers) {
      for (const category of paper.metadata.categories) {
        categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
      }
    }

    const compiledTruth = [
      `# ${opts.dataset.title}`,
      '',
      `${opts.dataset.description} [Source: compiled from ArXiv metadata, ${generatedAt}]`,
      '',
      '## Papers',
      ...opts.papers.map((paper) =>
        `- ${relativeMarkdownLink(collectionPath, paperPathForPaper(paper.metadata), paper.metadata.title)} by ${paper.metadata.authors.join(', ')}. [Source: ArXiv, ${paper.metadata.absUrl}]`,
      ),
      '',
      '## Categories',
      ...[...categoryCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([category, count]) => `- ${category}: ${count} paper${count === 1 ? '' : 's'}. [Source: compiled from ArXiv metadata, ${generatedAt}]`),
    ].join('\n');

    const timeline = [
      '## Timeline',
      '',
      ...opts.papers
        .slice()
        .sort((a, b) => isoDate(a.metadata.published).localeCompare(isoDate(b.metadata.published)))
        .map((paper) =>
          `- **${isoDate(paper.metadata.published) || generatedAt}** | Added ${relativeMarkdownLink(collectionPath, paperPathForPaper(paper.metadata), paper.metadata.title)} to the ${opts.dataset.title} batch. [Source: ArXiv, ${paper.metadata.absUrl}]`,
        ),
    ].join('\n');

    pages.push({
      path: collectionPath,
      content: serializeMarkdown(
        cleanFrontmatter({
          source_type: 'arxiv',
          dataset_id: opts.dataset.id,
          generated_at: generatedAt,
          paper_count: opts.papers.length,
          tags: ['arxiv-collection'],
        }),
        compiledTruth,
        timeline,
        { type: 'concept', title: opts.dataset.title, tags: ['arxiv-collection'] },
      ),
    });
  }

  return {
    pages,
    paperSlugs,
    authorPaths,
    collectionPaths,
    existingAuthorSlugs: [...skippedAuthorSlugs],
  };
}

export async function readCompiledPage(outputDir: string, relPath: string): Promise<string> {
  return readFile(path.join(outputDir, relPath), 'utf-8');
}

export function paperPathForPaper(paper: ArxivPaper): string {
  const titleSlug = slugifySegment(paper.title).slice(0, 72) || 'paper';
  return path.join('sources', 'arxiv', `${titleSlug}-${paper.arxivId.replace(/[^\w.-]+/g, '-')}.md`);
}

export function slugForAuthor(author: string): string {
  return `people/${slugifySegment(author)}`;
}

function relativeMarkdownLink(fromPath: string, toPath: string, label: string): string {
  const relativeTarget = path.relative(path.dirname(fromPath), toPath).replace(/\\/g, '/');
  return `[${label}](${relativeTarget})`;
}

function isoDate(value: string): string {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString().slice(0, 10);
}

function cleanFrontmatter<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}
