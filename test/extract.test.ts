import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  extractMarkdownLinks,
  extractWikiLinks,
  buildNameToSlugMap,
  extractLinksFromFile,
  extractTimelineFromContent,
  extractTimelineFromFrontmatter,
  walkMarkdownFiles,
  runExtract,
} from '../src/commands/extract.ts';

describe('extractMarkdownLinks', () => {
  it('extracts relative markdown links', () => {
    const content = 'Check [Pedro](../people/pedro-franceschi.md) and [Brex](../../companies/brex.md).';
    const links = extractMarkdownLinks(content);
    expect(links).toHaveLength(2);
    expect(links[0].name).toBe('Pedro');
    expect(links[0].relTarget).toBe('../people/pedro-franceschi.md');
  });

  it('skips external URLs ending in .md', () => {
    const content = 'See [readme](https://example.com/readme.md) for details.';
    const links = extractMarkdownLinks(content);
    expect(links).toHaveLength(0);
  });

  it('handles links with no matches', () => {
    const content = 'No links here.';
    expect(extractMarkdownLinks(content)).toHaveLength(0);
  });

  it('extracts multiple links from same line', () => {
    const content = '[A](a.md) and [B](b.md)';
    expect(extractMarkdownLinks(content)).toHaveLength(2);
  });
});

describe('extractLinksFromFile', () => {
  it('resolves relative paths to slugs', () => {
    const content = '---\ntitle: Test\n---\nSee [Pedro](../people/pedro.md).';
    const allSlugs = new Set(['people/pedro', 'deals/test-deal']);
    const links = extractLinksFromFile(content, 'deals/test-deal.md', allSlugs);
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links[0].from_slug).toBe('deals/test-deal');
    expect(links[0].to_slug).toBe('people/pedro');
  });

  it('skips links to non-existent pages', () => {
    const content = 'See [Ghost](../people/ghost.md).';
    const allSlugs = new Set(['deals/test']);
    const links = extractLinksFromFile(content, 'deals/test.md', allSlugs);
    expect(links).toHaveLength(0);
  });

  it('extracts frontmatter company links', () => {
    const content = '---\ncompany: brex\ntype: person\n---\nContent.';
    const allSlugs = new Set(['people/test']);
    const links = extractLinksFromFile(content, 'people/test.md', allSlugs);
    const companyLinks = links.filter(l => l.link_type === 'works_at');
    expect(companyLinks.length).toBeGreaterThanOrEqual(1);
    expect(companyLinks[0].to_slug).toBe('companies/brex');
  });

  it('handles attendee objects with name field (granola format)', () => {
    const content = '---\nattendees:\n  - name: Kazuki\n    company: Kaigo\n    email: k@kaigo.ai\ntype: meeting\n---\nBody.';
    const allSlugs = new Set(['meetings/test']);
    const links = extractLinksFromFile(content, 'meetings/test.md', allSlugs);
    const attendeeLinks = links.filter(l => l.link_type === 'attendee');
    expect(attendeeLinks.length).toBeGreaterThanOrEqual(1);
    expect(attendeeLinks[0].to_slug).toBe('people/kazuki');
  });

  it('extracts frontmatter investors array', () => {
    const content = '---\ninvestors: [yc, threshold]\ntype: deal\n---\nContent.';
    const allSlugs = new Set(['deals/seed']);
    const links = extractLinksFromFile(content, 'deals/seed.md', allSlugs);
    const investorLinks = links.filter(l => l.link_type === 'invested_in');
    expect(investorLinks).toHaveLength(2);
  });

  it('infers link type from directory structure', () => {
    const content = 'See [Brex](../companies/brex.md).';
    const allSlugs = new Set(['people/pedro', 'companies/brex']);
    const links = extractLinksFromFile(content, 'people/pedro.md', allSlugs);
    expect(links[0].link_type).toBe('works_at');
  });

  it('infers deal_for type for deals -> companies', () => {
    const content = 'See [Brex](../companies/brex.md).';
    const allSlugs = new Set(['deals/seed', 'companies/brex']);
    const links = extractLinksFromFile(content, 'deals/seed.md', allSlugs);
    expect(links[0].link_type).toBe('deal_for');
  });
});

describe('extractTimelineFromContent', () => {
  it('extracts bullet format entries', () => {
    const content = `## Timeline\n- **2025-03-18** | Meeting — Discussed partnership`;
    const entries = extractTimelineFromContent(content, 'people/test');
    expect(entries).toHaveLength(1);
    expect(entries[0].date).toBe('2025-03-18');
    expect(entries[0].source).toBe('Meeting');
    expect(entries[0].summary).toBe('Discussed partnership');
  });

  it('extracts header format entries', () => {
    const content = `### 2025-03-28 — Round Closed\n\nAll docs signed. Marcus joins the board.`;
    const entries = extractTimelineFromContent(content, 'deals/seed');
    expect(entries).toHaveLength(1);
    expect(entries[0].date).toBe('2025-03-28');
    expect(entries[0].summary).toBe('Round Closed');
    expect(entries[0].detail).toContain('Marcus joins the board');
  });

  it('returns empty for no timeline content', () => {
    const content = 'Just plain text without dates.';
    expect(extractTimelineFromContent(content, 'test')).toHaveLength(0);
  });

  it('extracts multiple bullet entries', () => {
    const content = `- **2025-01-01** | Source1 — Summary1\n- **2025-02-01** | Source2 — Summary2`;
    const entries = extractTimelineFromContent(content, 'test');
    expect(entries).toHaveLength(2);
  });

  it('handles em dash and en dash in bullet format', () => {
    const content = `- **2025-03-18** | Meeting – Discussed partnership`;
    const entries = extractTimelineFromContent(content, 'test');
    expect(entries).toHaveLength(1);
  });
});

describe('walkMarkdownFiles', () => {
  it('is a function', () => {
    expect(typeof walkMarkdownFiles).toBe('function');
  });
});

describe('extractWikiLinks', () => {
  it('extracts simple wiki-links', () => {
    const content = 'See [[Author - _avichawla]] for details.';
    const links = extractWikiLinks(content);
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe('Author - _avichawla');
    expect(links[0].name).toBe('Author - _avichawla');
  });

  it('extracts wiki-links with alias', () => {
    const content = '[[Collection - Karpathy LLM Knowledge Base Cluster|Karpathy LLM Cluster]]';
    const links = extractWikiLinks(content);
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe('Collection - Karpathy LLM Knowledge Base Cluster');
    expect(links[0].name).toBe('Karpathy LLM Cluster');
  });

  it('extracts multiple wiki-links', () => {
    const content = '[[Page A]] and [[Page B|alias B]]';
    const links = extractWikiLinks(content);
    expect(links).toHaveLength(2);
  });

  it('returns empty for no wiki-links', () => {
    expect(extractWikiLinks('No wiki links here.')).toHaveLength(0);
  });
});

describe('buildNameToSlugMap', () => {
  it('maps basename to slug', () => {
    const files = [
      { relPath: '15 Authors/Author - _avichawla.md' },
      { relPath: '10 Sources/X/X - _avichawla - Compiled Wiki.md' },
    ];
    const map = buildNameToSlugMap(files);
    expect(map.get('Author - _avichawla')).toEqual(['15 Authors/Author - _avichawla']);
    expect(map.get('X - _avichawla - Compiled Wiki')).toEqual(['10 Sources/X/X - _avichawla - Compiled Wiki']);
  });

  it('detects ambiguous names (multiple slugs per basename)', () => {
    const files = [
      { relPath: 'dir1/Shared Name.md' },
      { relPath: 'dir2/Shared Name.md' },
    ];
    const map = buildNameToSlugMap(files);
    expect(map.get('Shared Name')?.length).toBe(2);
  });
});

describe('extractLinksFromFile with wiki-links', () => {
  it('resolves wiki-links to slugs via nameToSlug map', () => {
    const content = '---\ntitle: Test\n---\nSee [[Author - _avichawla]].';
    const allSlugs = new Set(['15 Authors/Author - _avichawla', 'sources/test']);
    const nameToSlug = new Map([['Author - _avichawla', ['15 Authors/Author - _avichawla']]]);
    const links = extractLinksFromFile(content, 'sources/test.md', allSlugs, nameToSlug);
    const wikiLinks = links.filter(l => l.context.includes('wiki link'));
    expect(wikiLinks).toHaveLength(1);
    expect(wikiLinks[0].to_slug).toBe('15 Authors/Author - _avichawla');
  });

  it('skips ambiguous wiki-links', () => {
    const content = 'See [[Ambiguous Page]].';
    const allSlugs = new Set(['dir1/Ambiguous Page', 'dir2/Ambiguous Page', 'sources/test']);
    const nameToSlug = new Map([['Ambiguous Page', ['dir1/Ambiguous Page', 'dir2/Ambiguous Page']]]);
    const links = extractLinksFromFile(content, 'sources/test.md', allSlugs, nameToSlug);
    expect(links.filter(l => l.context.includes('wiki link'))).toHaveLength(0);
  });

  it('skips self-links in wiki-links', () => {
    const content = '[[Self Page]]';
    const allSlugs = new Set(['sources/Self Page']);
    const nameToSlug = new Map([['Self Page', ['sources/Self Page']]]);
    const links = extractLinksFromFile(content, 'sources/Self Page.md', allSlugs, nameToSlug);
    expect(links.filter(l => l.context.includes('wiki link'))).toHaveLength(0);
  });
});

describe('extractTimelineFromFrontmatter', () => {
  it('extracts timeline entry for meeting with date and title', () => {
    const content = '---\ntitle: "Help & Care x Kaigo"\ntype: meeting\ndate: 2026-01-17\nsource: granola\n---\nBody.';
    const entries = extractTimelineFromFrontmatter(content, 'meetings/2026-01-17-help-care');
    expect(entries).toHaveLength(1);
    expect(entries[0].date).toBe('2026-01-17');
    expect(entries[0].summary).toBe('Help & Care x Kaigo');
    expect(entries[0].source).toBe('granola');
  });

  it('extracts timeline entry for page in meetings/ dir without explicit type', () => {
    const content = '---\ntitle: "Standup"\ndate: 2026-01-20\n---\nBody.';
    const entries = extractTimelineFromFrontmatter(content, 'meetings/2026-01-20-standup');
    expect(entries).toHaveLength(1);
  });

  it('skips author pages — has date but not in event dir or type', () => {
    const content = '---\ntitle: "Avi Chawla"\ncreated: 2025-06-01\n---\nBody.';
    const entries = extractTimelineFromFrontmatter(content, '15 Authors/Author - _avichawla');
    expect(entries).toHaveLength(0);
  });

  it('extracts timeline entry for meeting even without explicit title (inferTitle from filename)', () => {
    const content = '---\ntype: meeting\ndate: 2026-01-17\n---\nBody.';
    const entries = extractTimelineFromFrontmatter(content, 'meetings/2026-01-17-standup');
    expect(entries).toHaveLength(1);
    // title is inferred from filename when not explicit
    expect(entries[0].date).toBe('2026-01-17');
  });

  it('skips pages with invalid date format', () => {
    const content = '---\ntitle: "Test"\ntype: meeting\ndate: January 2026\n---\nBody.';
    const entries = extractTimelineFromFrontmatter(content, 'meetings/test');
    expect(entries).toHaveLength(0);
  });

  it('also extracts for gdocs/ pages', () => {
    const content = '---\ntitle: "Board Meeting Notes"\ndate: 2026-02-01\n---\nBody.';
    const entries = extractTimelineFromFrontmatter(content, 'gdocs/board-meeting-notes');
    expect(entries).toHaveLength(1);
  });
});

describe('extractLinksFromDir: stub page creation for frontmatter targets', () => {
  let tmpDir: string;

  it('auto-creates a stub page for a frontmatter link target missing from DB, then stores the link', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-extract-stub-'));
    try {
      // Create meetings/ subdirectory with a meeting that references people/kazuki
      mkdirSync(join(tmpDir, 'meetings'));
      writeFileSync(join(tmpDir, 'meetings', 'test-meeting.md'), [
        '---',
        'type: meeting',
        'date: 2026-01-15',
        'title: Test Meeting',
        'attendees: [kazuki]',
        '---',
        'Body.',
      ].join('\n'));

      // Mock engine: meeting page is in DB, people/kazuki is NOT
      const putPageCalls: Array<{ slug: string; type: string }> = [];
      const addLinkCalls: Array<{ from: string; to: string; context: string | undefined }> = [];

      const mockEngine = {
        listPages: async () => [{ slug: 'meetings/test-meeting', title: 'Test Meeting', type: 'meeting' }],
        getLinks: async () => [],
        putPage: async (slug: string, page: { type: string }) => {
          putPageCalls.push({ slug, type: page.type });
        },
        addLink: async (from: string, to: string, context?: string) => {
          addLinkCalls.push({ from, to, context });
        },
        // Satisfy BrainEngine interface minimally
        connect: async () => {},
        disconnect: async () => {},
        getPage: async () => null,
        deletePage: async () => {},
        searchPages: async () => [],
        getTimeline: async () => [],
        addTimelineEntry: async () => {},
        deleteTimeline: async () => {},
        listConnections: async () => [],
        countPages: async () => 0,
        getConfig: async () => ({}),
        setConfig: async () => {},
        listChunks: async () => [],
        upsertChunk: async () => {},
        deleteChunks: async () => {},
        searchChunks: async () => [],
        getStats: async () => ({}),
        runSQL: async () => [],
        vacuum: async () => {},
      };

      await runExtract(mockEngine as any, ['links', '--dir', tmpDir]);

      // putPage should have been called to create the stub for people/kazuki
      const kazukiStub = putPageCalls.find(c => c.slug === 'people/kazuki');
      expect(kazukiStub).toBeDefined();
      expect(kazukiStub?.type).toBe('person');

      // addLink should have been called to store the attendee link
      const attendeeLink = addLinkCalls.find(c => c.to === 'people/kazuki');
      expect(attendeeLink).toBeDefined();
      expect(attendeeLink?.from).toBe('meetings/test-meeting');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips stub creation when target page already exists in DB', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-extract-stub-'));
    try {
      mkdirSync(join(tmpDir, 'meetings'));
      writeFileSync(join(tmpDir, 'meetings', 'test-meeting.md'), [
        '---',
        'type: meeting',
        'date: 2026-01-15',
        'title: Test Meeting',
        'attendees: [kazuki]',
        '---',
        'Body.',
      ].join('\n'));

      const putPageCalls: string[] = [];
      const mockEngine = {
        // people/kazuki already in DB
        listPages: async () => [
          { slug: 'meetings/test-meeting', title: 'Test Meeting', type: 'meeting' },
          { slug: 'people/kazuki', title: 'kazuki', type: 'person' },
        ],
        getLinks: async () => [],
        putPage: async (slug: string) => { putPageCalls.push(slug); },
        addLink: async () => {},
        connect: async () => {},
        disconnect: async () => {},
        getPage: async () => null,
        deletePage: async () => {},
        searchPages: async () => [],
        getTimeline: async () => [],
        addTimelineEntry: async () => {},
        deleteTimeline: async () => {},
        listConnections: async () => [],
        countPages: async () => 0,
        getConfig: async () => ({}),
        setConfig: async () => {},
        listChunks: async () => [],
        upsertChunk: async () => {},
        deleteChunks: async () => {},
        searchChunks: async () => [],
        getStats: async () => ({}),
        runSQL: async () => [],
        vacuum: async () => {},
      };

      await runExtract(mockEngine as any, ['links', '--dir', tmpDir]);

      // putPage should NOT have been called since people/kazuki is already in DB
      expect(putPageCalls).not.toContain('people/kazuki');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
