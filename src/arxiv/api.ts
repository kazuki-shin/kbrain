import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

export interface ArxivPaper {
  arxivId: string;
  versionedId: string;
  version: string | null;
  title: string;
  abstract: string;
  authors: string[];
  categories: string[];
  primaryCategory: string | null;
  published: string;
  updated: string;
  absUrl: string;
  pdfUrl: string;
}

export interface ArxivWorkspace {
  rootDir: string;
  rawDir: string;
  pdfDir: string;
  metadataDir: string;
  textDir: string;
  compiledDir: string;
}

interface ParsedArxivId {
  canonicalId: string;
  versionedId: string;
  version: string | null;
}

const XML = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  trimValues: true,
  parseTagValue: false,
});

const MODERN_ID_RE = /^(\d{4}\.\d{4,5})(v\d+)?$/i;
const LEGACY_ID_RE = /^([a-z-]+(?:\.[A-Z-]+)?\/\d{7})(v\d+)?$/i;

export function resolveArxivWorkspace(rootDir: string): ArxivWorkspace {
  return {
    rootDir,
    rawDir: path.join(rootDir, 'raw'),
    pdfDir: path.join(rootDir, 'raw', 'pdfs'),
    metadataDir: path.join(rootDir, 'raw', 'metadata'),
    textDir: path.join(rootDir, 'raw', 'text'),
    compiledDir: path.join(rootDir, 'compiled'),
  };
}

export function normalizeArxivInput(input: string): ParsedArxivId {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('ArXiv input cannot be empty.');
  }

  const fromUrl = trimmed.match(
    /^(?:https?:\/\/)?(?:www\.)?(?:export\.)?arxiv\.org\/(?:abs|pdf)\/([^?#]+?)(?:\.pdf)?$/i,
  );
  const candidate = fromUrl ? fromUrl[1] : trimmed.replace(/^arxiv:/i, '');

  const modern = candidate.match(MODERN_ID_RE);
  if (modern) {
    return {
      canonicalId: modern[1],
      versionedId: `${modern[1]}${modern[2] ?? ''}`,
      version: modern[2] ?? null,
    };
  }

  const legacy = candidate.match(LEGACY_ID_RE);
  if (legacy) {
    return {
      canonicalId: legacy[1],
      versionedId: `${legacy[1]}${legacy[2] ?? ''}`,
      version: legacy[2] ?? null,
    };
  }

  throw new Error(`Unsupported ArXiv URL/ID: ${input}`);
}

export function collectArxivInputs(args: string[]): string[] {
  const valueFlags = new Set([
    '--workspace',
    '--urls-from',
    '--ids-from',
    '--output-dir',
    '--pdf-dir',
    '--dataset-id',
    '--title',
    '--description',
    '--max-text-chars',
    '--llm-model',
  ]);

  const skipIndexes = new Set<number>();
  for (let i = 0; i < args.length; i++) {
    if (valueFlags.has(args[i])) skipIndexes.add(i + 1);
  }

  return args.filter((arg, index) => {
    if (skipIndexes.has(index)) return false;
    if (arg.startsWith('--')) return false;
    try {
      normalizeArxivInput(arg);
      return true;
    } catch {
      return false;
    }
  });
}

export async function fetchArxivMetadata(inputs: string[]): Promise<ArxivPaper[]> {
  const normalized = inputs.map(normalizeArxivInput);
  const uniqueVersionedIds = [...new Set(normalized.map((entry) => entry.versionedId))];
  const papers: ArxivPaper[] = [];

  for (let i = 0; i < uniqueVersionedIds.length; i += 20) {
    const chunk = uniqueVersionedIds.slice(i, i + 20);
    const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(chunk.join(','))}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'gbrain-arxiv-ingest/0.10.1' },
    });
    if (!response.ok) {
      throw new Error(`ArXiv API request failed (${response.status} ${response.statusText})`);
    }
    const xml = await response.text();
    const parsed = XML.parse(xml) as Record<string, any>;
    const entries = toArray(parsed.feed?.entry);
    for (const entry of entries) {
      papers.push(parseEntry(entry));
    }
  }

  const byVersionedId = new Map(papers.map((paper) => [paper.versionedId, paper]));
  const byCanonicalId = new Map(papers.map((paper) => [paper.arxivId, paper]));

  return normalized.map((entry) => {
    const paper = byVersionedId.get(entry.versionedId) ?? byCanonicalId.get(entry.canonicalId);
    if (!paper) {
      throw new Error(`ArXiv metadata not found for ${entry.versionedId}`);
    }
    return paper;
  });
}

export async function downloadArxivPdf(paper: ArxivPaper, pdfDir: string): Promise<string> {
  await mkdir(pdfDir, { recursive: true });
  const filePath = path.join(pdfDir, `${safeFileSegment(paper.versionedId)}.pdf`);
  const response = await fetch(pdfUrlWithExtension(paper.pdfUrl), {
    headers: { 'User-Agent': 'gbrain-arxiv-ingest/0.10.1' },
  });
  if (!response.ok) {
    throw new Error(`PDF download failed for ${paper.versionedId} (${response.status} ${response.statusText})`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(filePath, buffer);
  return filePath;
}

export async function writePaperMetadata(paper: ArxivPaper, metadataDir: string): Promise<string> {
  await mkdir(metadataDir, { recursive: true });
  const filePath = path.join(metadataDir, `${safeFileSegment(paper.versionedId)}.json`);
  await writeFile(filePath, JSON.stringify(paper, null, 2) + '\n', 'utf-8');
  return filePath;
}

function parseEntry(entry: Record<string, any>): ArxivPaper {
  const idUrl = String(entry.id ?? '');
  const versionedId = idUrl.split('/abs/').pop() ?? idUrl;
  const normalized = normalizeArxivInput(versionedId);
  const links = toArray(entry.link);
  const pdfLink = links.find((link) => link.type === 'application/pdf' || link.title === 'pdf');
  const absLink = links.find((link) => link.rel === 'alternate' && link.type === 'text/html');
  const authors = toArray(entry.author).map((author) => String(author.name ?? '').trim()).filter(Boolean);
  const categories = toArray(entry.category).map((category) => String(category.term ?? '').trim()).filter(Boolean);

  return {
    arxivId: normalized.canonicalId,
    versionedId: normalized.versionedId,
    version: normalized.version,
    title: compact(String(entry.title ?? 'Untitled')),
    abstract: compact(String(entry.summary ?? '')),
    authors,
    categories,
    primaryCategory: entry['arxiv:primary_category']?.term ? String(entry['arxiv:primary_category'].term) : (categories[0] ?? null),
    published: String(entry.published ?? ''),
    updated: String(entry.updated ?? ''),
    absUrl: String(absLink?.href ?? `https://arxiv.org/abs/${normalized.versionedId}`),
    pdfUrl: pdfUrlWithExtension(String(pdfLink?.href ?? `https://arxiv.org/pdf/${normalized.versionedId}`)),
  };
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function pdfUrlWithExtension(url: string): string {
  return url.endsWith('.pdf') ? url : `${url}.pdf`;
}

function safeFileSegment(value: string): string {
  return value.replace(/[^\w.-]+/g, '-');
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}
