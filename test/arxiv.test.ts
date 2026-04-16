import { describe, expect, test } from 'bun:test';
import { collectArxivInputs, normalizeArxivInput } from '../src/arxiv/api.ts';
import { buildArxivPages, paperPathForPaper } from '../src/arxiv/compiler.ts';
import { summarizeDeterministically } from '../src/arxiv/summary.ts';

const samplePaper = {
  arxivId: '2401.00001',
  versionedId: '2401.00001v1',
  version: 'v1',
  title: 'Home Care Agents for Robotics',
  abstract:
    'We present a home care robotics pipeline for multimodal planning, longitudinal monitoring, and safety interventions.',
  authors: ['Jane Doe', 'John Smith'],
  categories: ['cs.RO', 'cs.AI'],
  primaryCategory: 'cs.RO',
  published: '2026-01-05T12:00:00Z',
  updated: '2026-01-06T12:00:00Z',
  absUrl: 'https://arxiv.org/abs/2401.00001v1',
  pdfUrl: 'https://arxiv.org/pdf/2401.00001v1.pdf',
};

const sampleSummary = {
  contributionSummary: 'The paper proposes a robotics pipeline for home care workflows.',
  keyFindings: [
    'The system integrates multimodal planning with longitudinal monitoring.',
    'Safety interventions are evaluated in realistic care scenarios.',
  ],
  relevanceSummary: 'Relevant to home care AI and robotics programs already tracked in the brain.',
  summarySource: 'deterministic' as const,
};

describe('arxiv api', () => {
  test('normalizes abs URLs and pdf URLs', () => {
    expect(normalizeArxivInput('https://arxiv.org/abs/2401.00001v1')).toEqual({
      canonicalId: '2401.00001',
      versionedId: '2401.00001v1',
      version: 'v1',
    });
    expect(normalizeArxivInput('https://arxiv.org/pdf/2401.00001.pdf')).toEqual({
      canonicalId: '2401.00001',
      versionedId: '2401.00001',
      version: null,
    });
  });

  test('supports legacy arxiv ids', () => {
    expect(normalizeArxivInput('cs.AI/0601001v2')).toEqual({
      canonicalId: 'cs.AI/0601001',
      versionedId: 'cs.AI/0601001v2',
      version: 'v2',
    });
  });

  test('collects only valid free-form arxiv inputs from argv', () => {
    expect(
      collectArxivInputs([
        '--workspace',
        '.arxiv',
        '2401.00001',
        '--title',
        'Reading List',
        'https://arxiv.org/abs/2402.00002v3',
        'not-an-id',
      ]),
    ).toEqual(['2401.00001', 'https://arxiv.org/abs/2402.00002v3']);
  });
});

describe('arxiv compiler', () => {
  test('builds paper pages and skips author pages that already exist', () => {
    const built = buildArxivPages({
      dataset: {
        id: 'home-care-arxiv',
        title: 'Home Care Arxiv',
        description: 'Batch import for home care papers.',
      },
      papers: [
        {
          metadata: samplePaper,
          extractedText: 'Full extracted paper text.',
          pageCount: 8,
          truncated: false,
          pdfPath: '/tmp/2401.00001.pdf',
          metadataPath: '/tmp/2401.00001.json',
          textPath: '/tmp/2401.00001.txt',
          summary: sampleSummary,
          relatedPages: [
            { slug: 'concepts/home-care-ai', title: 'Home Care AI', type: 'concept' },
            { slug: 'companies/kaigo', title: 'Kaigo', type: 'company' },
          ],
        },
      ],
      outputDir: '/tmp/out',
      existingAuthorSlugs: new Set(['people/john-smith']),
      createCollection: false,
    });

    const paths = built.pages.map((page) => page.path).sort();
    expect(paths).toContain(paperPathForPaper(samplePaper));
    expect(paths).toContain('people/jane-doe.md');
    expect(paths).not.toContain('people/john-smith.md');
    expect(paths).not.toContain('collections/home-care-arxiv.md');

    const paperPage = built.pages.find((page) => page.path === paperPathForPaper(samplePaper));
    expect(paperPage).toBeTruthy();
    expect(paperPage!.content).toContain('[Jane Doe](../../people/jane-doe.md)');
    expect(paperPage!.content).toContain('[John Smith](../../people/john-smith.md)');
    expect(paperPage!.content).toContain('[Home Care AI](../../concepts/home-care-ai.md)');
    expect(paperPage!.content).toContain('[Kaigo](../../companies/kaigo.md)');
  });

  test('creates a collection page for batch imports', () => {
    const built = buildArxivPages({
      dataset: {
        id: 'robotics-reading-list',
        title: 'Robotics Reading List',
        description: 'Recent robotics papers.',
      },
      papers: [
        {
          metadata: samplePaper,
          extractedText: 'Full extracted paper text.',
          pageCount: 8,
          truncated: false,
          pdfPath: '/tmp/2401.00001.pdf',
          metadataPath: '/tmp/2401.00001.json',
          textPath: '/tmp/2401.00001.txt',
          summary: sampleSummary,
          relatedPages: [],
        },
        {
          metadata: {
            ...samplePaper,
            arxivId: '2401.00002',
            versionedId: '2401.00002v1',
            title: 'Assistive Manipulation for Eldercare',
            absUrl: 'https://arxiv.org/abs/2401.00002v1',
            pdfUrl: 'https://arxiv.org/pdf/2401.00002v1.pdf',
          },
          extractedText: 'Second paper text.',
          pageCount: 10,
          truncated: false,
          pdfPath: '/tmp/2401.00002.pdf',
          metadataPath: '/tmp/2401.00002.json',
          textPath: '/tmp/2401.00002.txt',
          summary: sampleSummary,
          relatedPages: [],
        },
      ],
      outputDir: '/tmp/out',
      createCollection: true,
    });

    expect(built.pages.some((page) => page.path === 'collections/robotics-reading-list.md')).toBe(true);
  });
});

describe('arxiv summary', () => {
  test('falls back to deterministic summary fields', () => {
    const summary = summarizeDeterministically(
      samplePaper,
      `${samplePaper.abstract} We evaluate on two care environments. The system reduces intervention latency.`,
    );

    expect(summary.summarySource).toBe('deterministic');
    expect(summary.contributionSummary.length).toBeGreaterThan(20);
    expect(summary.keyFindings.length).toBeGreaterThan(0);
    expect(summary.relevanceSummary).toContain('cs.RO');
  });
});
