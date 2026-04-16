import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface ExtractedPdfText {
  text: string;
  pageCount: number;
  truncated: boolean;
}

export async function extractPdfText(
  pdfPath: string,
  opts: { maxChars?: number } = {},
): Promise<ExtractedPdfText> {
  const maxChars = opts.maxChars ?? 120_000;
  const bytes = await Bun.file(pdfPath).bytes();
  const doc = await pdfjs.getDocument({
    data: bytes,
    disableWorker: true,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  }).promise;

  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(normalizePageText(content.items as Array<{ str?: string; hasEOL?: boolean }>));
      if (pages.join('\n\n').length > maxChars * 1.5) {
        break;
      }
    }

    const merged = pages.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
    const truncated = merged.length > maxChars;
    return {
      text: truncated ? merged.slice(0, maxChars).trimEnd() : merged,
      pageCount: doc.numPages,
      truncated,
    };
  } finally {
    await doc.destroy();
  }
}

export async function writeExtractedText(
  versionedId: string,
  textDir: string,
  text: string,
): Promise<string> {
  await mkdir(textDir, { recursive: true });
  const filePath = path.join(textDir, `${versionedId.replace(/[^\w.-]+/g, '-')}.txt`);
  await writeFile(filePath, text, 'utf-8');
  return filePath;
}

function normalizePageText(items: Array<{ str?: string; hasEOL?: boolean }>): string {
  let text = '';

  for (const item of items) {
    const raw = item.str ?? '';
    const value = raw.replace(/\s+/g, ' ');
    if (value.trim()) {
      if (text && !text.endsWith('\n') && !text.endsWith(' ') && !value.startsWith(' ')) {
        text += ' ';
      }
      text += value.trim();
    }
    if (item.hasEOL) {
      text = text.trimEnd() + '\n';
    }
  }

  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n(?=[a-z])/g, ' ')
    .replace(/([a-z])- ([a-z])/g, '$1$2')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
