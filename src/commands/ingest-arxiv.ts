import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import { runBacklinks } from './backlinks.ts';
import { runExtract } from './extract.ts';
import { runImport } from './import.ts';
import {
  collectArxivInputs,
  downloadArxivPdf,
  fetchArxivMetadata,
  normalizeArxivInput,
  resolveArxivWorkspace,
  writePaperMetadata,
} from '../arxiv/api.ts';
import { compileArxivPapers, paperPathForPaper, slugForAuthor, type PreparedPaper } from '../arxiv/compiler.ts';
import { extractPdfText, writeExtractedText } from '../arxiv/pdf.ts';
import { summarizePaper } from '../arxiv/summary.ts';

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function humanizeDatasetId(value: string): string {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

function readListFile(filePath: string): string[] {
  return readFileSync(filePath, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

export function printIngestArxivHelp() {
  console.log(`Usage: gbrain ingest:arxiv [options] [arxiv-urls-or-ids...]

Fetch ArXiv metadata and PDFs, extract paper text, compile structured paper pages,
then import/extract them into the brain.

Options:
  --workspace <dir>       Workspace root for raw/, compiled/ (default: .arxiv)
  --urls-from <file>      Text file of ArXiv URLs and/or IDs
  --ids-from <file>       Alias for --urls-from
  --output-dir <dir>      Compiled markdown output directory
  --pdf-dir <dir>         Directory for downloaded PDFs
  --dataset-id <id>       Stable dataset id (default: derived from input filename)
  --title <title>         Collection page title for batch imports
  --description <text>    Collection page description
  --compile-only          Stop after writing compiled markdown + backlinks
  --no-import             Alias for --compile-only
  --no-embed              Pass through to gbrain import
  --no-llm                Skip LLM-assisted summary generation
  --llm-model <name>      Override summary model (default: gpt-4o-mini)
  --max-text-chars <n>    Cap extracted PDF text per paper (default: 120000)
  --json                  Emit JSON summary

Examples:
  gbrain ingest:arxiv 2401.00001
  gbrain ingest:arxiv https://arxiv.org/abs/2401.00001v1
  gbrain ingest:arxiv --urls-from inputs/arxiv-reading-list.txt
`);
}

export async function runIngestArxiv(engine: BrainEngine | null, args: string[]) {
  if (args.includes('--help') || args.includes('-h')) {
    printIngestArxivHelp();
    return;
  }

  const workspace = resolveArxivWorkspace(
    valueAfter(args, '--workspace') ?? path.resolve('.arxiv'),
  );
  const listPath = valueAfter(args, '--urls-from') ?? valueAfter(args, '--ids-from');
  const cliInputs = collectArxivInputs(args);
  const listInputs = listPath ? readListFile(listPath) : [];
  const allInputs = [...new Set([...cliInputs, ...listInputs].map((value) => normalizeArxivInput(value).versionedId))];
  const noEmbed = args.includes('--no-embed');
  const noLlm = args.includes('--no-llm');
  const jsonMode = args.includes('--json');
  const compileOnly = args.includes('--compile-only') || args.includes('--no-import');
  const maxTextChars = parsePositiveInt(valueAfter(args, '--max-text-chars'), 120_000);
  const llmModel = valueAfter(args, '--llm-model');

  const createCollection =
    allInputs.length > 1 ||
    Boolean(listPath) ||
    args.includes('--title') ||
    args.includes('--description');

  if (allInputs.length === 0) {
    throw new Error('Provide at least one ArXiv URL/ID or --urls-from <file>.');
  }

  const datasetId =
    valueAfter(args, '--dataset-id') ??
    (listPath
      ? path.basename(listPath, path.extname(listPath))
      : allInputs.length === 1
        ? `arxiv-${normalizeArxivInput(allInputs[0]).canonicalId.replace(/[^\w.-]+/g, '-')}`
        : 'arxiv-reading-list');
  const datasetTitle = valueAfter(args, '--title') ?? humanizeDatasetId(datasetId);
  const datasetDescription =
    valueAfter(args, '--description') ??
    (allInputs.length > 1
      ? `ArXiv paper batch imported for ${datasetTitle}.`
      : `ArXiv paper imported for ${datasetTitle}.`);
  const outputDir =
    valueAfter(args, '--output-dir') ??
    path.join(workspace.compiledDir, datasetId);
  const pdfDir = valueAfter(args, '--pdf-dir') ?? workspace.pdfDir;

  console.log(`Fetching ArXiv metadata for ${allInputs.length} paper(s)...`);
  const papers = await fetchArxivMetadata(allInputs);

  const existingAuthorSlugs = new Set<string>();
  const existingAuthorsByPaper = new Map<string, string[]>();
  const relatedPagesByPaper = new Map<string, Array<{ slug: string; title: string; type: string }>>();

  if (engine) {
    const existingPages = await engine.listPages({ limit: 100000 });
    const existingSlugSet = new Set(existingPages.map((page) => page.slug));
    for (const paper of papers) {
      const authorSlugs = paper.authors.map(slugForAuthor);
      existingAuthorsByPaper.set(
        paper.versionedId,
        authorSlugs.filter((slug) => existingSlugSet.has(slug)),
      );
      authorSlugs.forEach((slug) => {
        if (existingSlugSet.has(slug)) existingAuthorSlugs.add(slug);
      });
      relatedPagesByPaper.set(paper.versionedId, await findRelatedPages(engine, paper, new Set(authorSlugs)));
    }
  }

  const prepared: PreparedPaper[] = [];
  for (const paper of papers) {
    console.log(`Downloading and extracting ${paper.versionedId}...`);
    const pdfPath = await downloadArxivPdf(paper, pdfDir);
    const metadataPath = await writePaperMetadata(paper, workspace.metadataDir);
    const extracted = await extractPdfText(pdfPath, { maxChars: maxTextChars });
    const textPath = await writeExtractedText(paper.versionedId, workspace.textDir, extracted.text);
    const summary = await summarizePaper(paper, extracted.text, {
      disabled: noLlm,
      model: llmModel,
    });

    prepared.push({
      metadata: paper,
      extractedText: extracted.text,
      pageCount: extracted.pageCount,
      truncated: extracted.truncated,
      pdfPath: path.resolve(pdfPath),
      metadataPath: path.resolve(metadataPath),
      textPath: path.resolve(textPath),
      summary,
      relatedPages: relatedPagesByPaper.get(paper.versionedId) ?? [],
    });
  }

  const compileResult = await compileArxivPapers({
    dataset: {
      id: datasetId,
      title: datasetTitle,
      description: datasetDescription,
    },
    papers: prepared,
    outputDir,
    existingAuthorSlugs,
    createCollection,
  });

  await runBacklinks(['fix', '--dir', outputDir]);

  let importRan = false;
  if (!compileOnly) {
    if (!engine) {
      throw new Error('No brain configured. Run gbrain init, or use --compile-only.');
    }
    const importArgs = [outputDir];
    if (noEmbed) importArgs.push('--no-embed');
    await runImport(engine, importArgs);
    await runExtract(engine, ['all', '--dir', outputDir]);
    await wireExistingAuthorLinks(engine, prepared, existingAuthorsByPaper);
    await wireRelatedPageLinks(engine, prepared);
    importRan = true;
  }

  const summary = {
    status: 'ok',
    dataset_id: datasetId,
    output_dir: compileResult.outputDir,
    papers: prepared.length,
    paper_pages: compileResult.paperPages,
    author_pages: compileResult.authorPages,
    collection_pages: compileResult.collectionPages,
    existing_author_links: compileResult.existingAuthorLinks.length,
    imported: importRan,
  };

  if (jsonMode) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`ArXiv papers compiled to ${compileResult.outputDir}`);
  console.log(
    `  ${prepared.length} papers -> ${compileResult.pageCount} pages (${compileResult.paperPages} papers, ${compileResult.authorPages} authors, ${compileResult.collectionPages} collections)`,
  );
  if (importRan) {
    console.log('  Imported into brain, extracted links/timeline, and wired existing author/related-page links.');
  } else {
    console.log('  Compile-only mode: markdown written, backlinks fixed, import skipped.');
  }
}

async function findRelatedPages(
  engine: BrainEngine,
  paper: Awaited<ReturnType<typeof fetchArxivMetadata>>[number],
  excludedSlugs: Set<string>,
): Promise<Array<{ slug: string; title: string; type: string }>> {
  const query = [
    paper.title,
    paper.primaryCategory ?? '',
    paper.categories.slice(0, 3).join(' '),
    paper.abstract.slice(0, 280),
  ]
    .join(' ')
    .trim();

  if (!query) return [];

  const seen = new Set<string>();
  const results = await engine.searchKeyword(query, { limit: 12 });
  const related: Array<{ slug: string; title: string; type: string }> = [];
  for (const result of results) {
    if (seen.has(result.slug) || excludedSlugs.has(result.slug)) continue;
    if (!['person', 'company', 'concept', 'project', 'source'].includes(result.type)) continue;
    seen.add(result.slug);
    related.push({ slug: result.slug, title: result.title, type: result.type });
    if (related.length >= 6) break;
  }
  return related;
}

async function wireExistingAuthorLinks(
  engine: BrainEngine,
  prepared: PreparedPaper[],
  existingAuthorsByPaper: Map<string, string[]>,
) {
  for (const paper of prepared) {
    const paperSlug = paperPathForPaper(paper.metadata).replace(/\.md$/, '');
    const existingAuthors = existingAuthorsByPaper.get(paper.metadata.versionedId) ?? [];
    for (const authorSlug of existingAuthors) {
      try {
        await engine.addLink(authorSlug, paperSlug, 'authored arxiv paper', 'author_of');
      } catch {}
      try {
        await engine.addTimelineEntry(authorSlug, {
          date: paper.metadata.published.slice(0, 10) || new Date().toISOString().slice(0, 10),
          source: paperSlug,
          summary: `Authored ArXiv paper: ${paper.metadata.title}`,
          detail: `Referenced via ${paper.metadata.absUrl}`,
        });
      } catch {}
    }
  }
}

async function wireRelatedPageLinks(engine: BrainEngine, prepared: PreparedPaper[]) {
  for (const paper of prepared) {
    const paperSlug = paperPathForPaper(paper.metadata).replace(/\.md$/, '');
    for (const related of paper.relatedPages) {
      try {
        await engine.addLink(paperSlug, related.slug, `related arxiv paper: ${paper.metadata.versionedId}`, 'related');
      } catch {}
    }
  }
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}
