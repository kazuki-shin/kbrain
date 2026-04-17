import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We test the pure string-manipulation helpers by calling runCompile with a mock engine.
// This avoids any DB dependency.

import { runCompile } from '../src/commands/compile.ts';

// ──────────────────────────────────────────
// Mock engine factory
// ──────────────────────────────────────────
type MockLink = { from_slug: string; to_slug: string; link_type: string; context: string };

function makeMockEngine(links: MockLink[] = []) {
  return {
    async listPages() {
      const slugs = [...new Set(links.map(l => l.from_slug))];
      return slugs.map(slug => ({ slug }));
    },
    async getLinks(slug: string) {
      return links.filter(l => l.from_slug === slug);
    },
    // Unused methods — compile only calls listPages + getLinks
    async disconnect() {},
  } as any;
}

// ──────────────────────────────────────────
// Temp vault helpers
// ──────────────────────────────────────────
let tmpVault: string;

beforeEach(() => {
  tmpVault = join(tmpdir(), `gbrain-compile-test-${Date.now()}`);
  mkdirSync(tmpVault, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpVault)) rmSync(tmpVault, { recursive: true, force: true });
});

function vaultFile(relPath: string, content: string): string {
  const full = join(tmpVault, relPath);
  const dir = full.slice(0, full.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(full, content, 'utf-8');
  return full;
}

function readVault(relPath: string): string {
  return readFileSync(join(tmpVault, relPath), 'utf-8');
}

// ──────────────────────────────────────────
// Tests
// ──────────────────────────────────────────

describe('compile: no frontmatter links', () => {
  it('skips files that have no frontmatter-derived links', async () => {
    vaultFile('meetings/2026-01-17-standup.md', '---\ntitle: Standup\n---\nBody.');
    const engine = makeMockEngine([]); // no links at all
    const result = await runCompile(engine, ['--repo', tmpVault]);
    expect(result.pagesUpdated).toBe(0);
    expect(result.linksWritten).toBe(0);
    expect(readVault('meetings/2026-01-17-standup.md')).not.toContain('gbrain:compile');
  });

  it('removes stale connections block when DB has no frontmatter links', async () => {
    const staleContent = `---
title: Standup
---
Body.

## Connections

<!-- gbrain:compile:start -->
**Works at:** [[Brex]]
<!-- gbrain:compile:end -->
`;
    vaultFile('meetings/2026-01-17-standup.md', staleContent);

    // Engine returns a page but with only wiki-link context (not frontmatter)
    const engine = makeMockEngine([
      { from_slug: 'meetings/2026-01-17-standup', to_slug: 'companies/brex', link_type: 'deal_for', context: 'wiki link' },
    ]);
    const result = await runCompile(engine, ['--repo', tmpVault]);
    expect(result.pagesCleared).toBe(1);
    expect(readVault('meetings/2026-01-17-standup.md')).not.toContain('gbrain:compile');
    expect(readVault('meetings/2026-01-17-standup.md')).not.toContain('Brex');
  });
});

describe('compile: writes new connections', () => {
  it('appends ## Connections section for a file with no existing section', async () => {
    vaultFile('meetings/2026-01-17-standup.md', '---\ntitle: Standup\n---\nBody.\n');

    const engine = makeMockEngine([
      { from_slug: 'meetings/2026-01-17-standup', to_slug: '15 Authors/Author - Kazuki', link_type: 'attendee', context: 'frontmatter.attendees[0]' },
    ]);

    const result = await runCompile(engine, ['--repo', tmpVault]);
    expect(result.pagesUpdated).toBe(1);
    expect(result.linksWritten).toBe(1);

    const content = readVault('meetings/2026-01-17-standup.md');
    expect(content).toContain('## Connections');
    expect(content).toContain('<!-- gbrain:compile:start -->');
    expect(content).toContain('<!-- gbrain:compile:end -->');
    expect(content).toContain('[[Author - Kazuki]]');
    expect(content).toContain('**Attendees:**');
  });

  it('groups multiple link_types under separate labels', async () => {
    vaultFile('meetings/2026-01-17-foo.md', '---\ntitle: Foo\n---\nBody.\n');

    const engine = makeMockEngine([
      { from_slug: 'meetings/2026-01-17-foo', to_slug: '15 Authors/Author - Kazuki', link_type: 'attendee', context: 'frontmatter.attendees[0]' },
      { from_slug: 'meetings/2026-01-17-foo', to_slug: '15 Authors/Author - Pedro', link_type: 'attendee', context: 'frontmatter.attendees[1]' },
      { from_slug: 'meetings/2026-01-17-foo', to_slug: 'companies/brex', link_type: 'deal_for', context: 'frontmatter.company' },
    ]);

    const result = await runCompile(engine, ['--repo', tmpVault]);
    expect(result.pagesUpdated).toBe(1);
    expect(result.linksWritten).toBe(3);

    const content = readVault('meetings/2026-01-17-foo.md');
    expect(content).toContain('**Attendees:** [[Author - Kazuki]], [[Author - Pedro]]');
    expect(content).toContain('**Company:** [[brex]]');
  });
});

describe('compile: idempotency', () => {
  it('does not rewrite a file already containing the correct block', async () => {
    const slug = 'meetings/2026-01-17-standup';
    const initialContent = `---\ntitle: Standup\n---\nBody.\n\n## Connections\n\n<!-- gbrain:compile:start -->\n**Attendees:** [[Author - Kazuki]]\n<!-- gbrain:compile:end -->\n`;
    vaultFile(slug + '.md', initialContent);

    const engine = makeMockEngine([
      { from_slug: slug, to_slug: '15 Authors/Author - Kazuki', link_type: 'attendee', context: 'frontmatter.attendees[0]' },
    ]);

    const result = await runCompile(engine, ['--repo', tmpVault]);
    // Already up to date — nothing should be rewritten
    expect(result.pagesUpdated).toBe(0);
    expect(readVault(slug + '.md')).toBe(initialContent);
  });

  it('updates block when DB links change (full regeneration)', async () => {
    const slug = 'meetings/2026-01-17-standup';
    const staleContent = `---\ntitle: Standup\n---\nBody.\n\n## Connections\n\n<!-- gbrain:compile:start -->\n**Attendees:** [[Author - OldPerson]]\n<!-- gbrain:compile:end -->\n`;
    vaultFile(slug + '.md', staleContent);

    const engine = makeMockEngine([
      { from_slug: slug, to_slug: '15 Authors/Author - Kazuki', link_type: 'attendee', context: 'frontmatter.attendees[0]' },
    ]);

    const result = await runCompile(engine, ['--repo', tmpVault]);
    expect(result.pagesUpdated).toBe(1);

    const content = readVault(slug + '.md');
    expect(content).toContain('[[Author - Kazuki]]');
    expect(content).not.toContain('Author - OldPerson');
  });
});

describe('compile: user content outside markers is preserved', () => {
  it('keeps content after compile:end untouched', async () => {
    const slug = 'meetings/2026-01-17-standup';
    const content = `---\ntitle: Standup\n---\nBody.\n\n## Connections\n\n<!-- gbrain:compile:start -->\n**Attendees:** [[Author - OldPerson]]\n<!-- gbrain:compile:end -->\n\n## My Notes\n\nStuff I wrote.\n`;
    vaultFile(slug + '.md', content);

    const engine = makeMockEngine([
      { from_slug: slug, to_slug: '15 Authors/Author - Kazuki', link_type: 'attendee', context: 'frontmatter.attendees[0]' },
    ]);

    await runCompile(engine, ['--repo', tmpVault]);
    const result = readVault(slug + '.md');
    expect(result).toContain('## My Notes');
    expect(result).toContain('Stuff I wrote.');
    expect(result).toContain('[[Author - Kazuki]]');
  });
});

describe('compile: dry-run mode', () => {
  it('does not write files when --dry-run is passed', async () => {
    const slug = 'meetings/2026-01-17-standup';
    const original = '---\ntitle: Standup\n---\nBody.\n';
    vaultFile(slug + '.md', original);

    const engine = makeMockEngine([
      { from_slug: slug, to_slug: '15 Authors/Author - Kazuki', link_type: 'attendee', context: 'frontmatter.attendees[0]' },
    ]);

    const result = await runCompile(engine, ['--repo', tmpVault, '--dry-run']);
    expect(result.pagesUpdated).toBe(1);
    // File content unchanged in dry-run
    expect(readVault(slug + '.md')).toBe(original);
  });
});

describe('compile: slug filter (autopilot mode)', () => {
  it('only processes the provided slugs', async () => {
    vaultFile('meetings/meeting-a.md', '---\ntitle: A\n---\nBody.\n');
    vaultFile('meetings/meeting-b.md', '---\ntitle: B\n---\nBody.\n');

    const engine = makeMockEngine([
      { from_slug: 'meetings/meeting-a', to_slug: '15 Authors/Author - Kazuki', link_type: 'attendee', context: 'frontmatter.attendees[0]' },
      { from_slug: 'meetings/meeting-b', to_slug: '15 Authors/Author - Pedro', link_type: 'attendee', context: 'frontmatter.attendees[0]' },
    ]);

    // Only compile meeting-a
    const result = await runCompile(engine, ['--repo', tmpVault], ['meetings/meeting-a']);
    expect(result.pagesUpdated).toBe(1);
    expect(readVault('meetings/meeting-a.md')).toContain('[[Author - Kazuki]]');
    expect(readVault('meetings/meeting-b.md')).not.toContain('gbrain:compile');
  });
});

describe('compile: missing vault file', () => {
  it('skips slugs that have no vault .md file', async () => {
    // No file created — slug only exists in DB
    const engine = makeMockEngine([
      { from_slug: 'people/ghost', to_slug: 'companies/nowhere', link_type: 'works_at', context: 'frontmatter.company' },
    ]);

    const result = await runCompile(engine, ['--repo', tmpVault]);
    expect(result.pagesUpdated).toBe(0);
  });
});
