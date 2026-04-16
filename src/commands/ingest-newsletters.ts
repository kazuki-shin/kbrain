import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import type { BrainEngine } from '../core/engine.ts';
import { runExtract } from './extract.ts';
import { runImport } from './import.ts';
import { fetchNewsletterIssues, buildNewsletterQuery } from '../newsletters/gmail.ts';
import { buildNewsletterPage } from '../newsletters/compiler.ts';

interface NewsletterState {
  known_message_ids: Record<string, { slug: string; ingested_at: string }>;
  last_run_at?: string;
}

interface BrainPageRef {
  slug: string;
  title: string;
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function numberAfter(args: string[], flag: string): number | undefined {
  const value = valueAfter(args, flag);
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function defaultWorkspaceRoot(): string {
  return path.join(homedir(), '.gbrain', 'newsletters');
}

function defaultStatePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, 'state.json');
}

function defaultCompiledDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, 'compiled');
}

function defaultRawDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, 'raw');
}

function integrationHeartbeatPath(): string {
  return path.join(homedir(), '.gbrain', 'integrations', 'email-to-brain', 'heartbeat.jsonl');
}

function loadState(statePath: string): NewsletterState {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8')) as NewsletterState;
  } catch {
    return { known_message_ids: {} };
  }
}

function saveState(statePath: string, state: NewsletterState): void {
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function appendHeartbeat(event: string, status: string, details: Record<string, unknown>) {
  const heartbeatPath = integrationHeartbeatPath();
  mkdirSync(path.dirname(heartbeatPath), { recursive: true });
  appendFileSync(
    heartbeatPath,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      event,
      source_version: '0.8.0',
      status,
      details,
    })}\n`,
  );
}

function buildBrainIndex(pages: BrainPageRef[]): Map<string, BrainPageRef[]> {
  const index = new Map<string, BrainPageRef[]>();
  for (const page of pages) {
    const key = normalizeForMatch(page.title);
    if (!key) continue;
    const bucket = index.get(key) || [];
    bucket.push(page);
    index.set(key, bucket);
  }
  return index;
}

export function matchExistingBrainPages(
  entityNames: string[],
  pages: BrainPageRef[],
): BrainPageRef[] {
  const index = buildBrainIndex(pages);
  const matches = new Map<string, BrainPageRef>();
  for (const entityName of entityNames) {
    for (const page of index.get(normalizeForMatch(entityName)) || []) {
      matches.set(page.slug, page);
    }
  }
  return [...matches.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

export function printIngestNewslettersHelp() {
  console.log(`Usage: gbrain ingest:newsletters [options]

Fetch Gmail messages labeled as newsletters, compile one brain page per issue,
and optionally import them into the brain.

Options:
  --workspace <dir>       Runtime workspace for raw/ compiled/ state.json
  --compiled-dir <dir>    Override compiled markdown output directory
  --raw-dir <dir>         Override raw Gmail JSON output directory
  --state <path>          Override idempotency state file
  --token-path <path>     Google OAuth token file (default: ~/.gbrain/google-tokens.json)
  --authuser <email>      Gmail account email for Open in Gmail links
  --label <name>          Gmail label to query (default: news)
  --backfill              Query a historical window instead of the full label
  --days <n>              Historical lookback window for --backfill
  --max <n>               Limit messages fetched this run
  --compile-only          Fetch + compile markdown only
  --no-import             Alias for --compile-only
  --no-embed             Pass through to gbrain import
  --json                  Emit JSON summary

Examples:
  gbrain ingest:newsletters
  gbrain ingest:newsletters --backfill --days 30
  gbrain ingest:newsletters --compile-only --max 10
`);
}

export async function runIngestNewsletters(engine: BrainEngine | null, args: string[]) {
  if (args.includes('--help') || args.includes('-h')) {
    printIngestNewslettersHelp();
    return;
  }

  const workspaceRoot = valueAfter(args, '--workspace') || defaultWorkspaceRoot();
  const compiledDir = valueAfter(args, '--compiled-dir') || defaultCompiledDir(workspaceRoot);
  const rawDir = valueAfter(args, '--raw-dir') || defaultRawDir(workspaceRoot);
  const statePath = valueAfter(args, '--state') || defaultStatePath(workspaceRoot);
  const tokenPath = valueAfter(args, '--token-path');
  const authuser = valueAfter(args, '--authuser') || process.env.GMAIL_AUTHUSER || process.env.GOOGLE_ACCOUNT_EMAIL;
  const label = valueAfter(args, '--label') || 'news';
  const backfill = args.includes('--backfill');
  const days = numberAfter(args, '--days');
  const maxMessages = numberAfter(args, '--max');
  const jsonMode = args.includes('--json');
  const compileOnly = args.includes('--compile-only') || args.includes('--no-import');
  const noEmbed = args.includes('--no-embed');

  if (!compileOnly && !engine) {
    throw new Error('No brain configured. Run gbrain init, or use --compile-only.');
  }

  mkdirSync(compiledDir, { recursive: true });
  mkdirSync(rawDir, { recursive: true });

  const state = loadState(statePath);
  const issues = await fetchNewsletterIssues({
    authuser,
    label,
    backfill,
    days,
    maxMessages,
    tokenPath,
  });

  const newIssues = issues.filter((issue) => !state.known_message_ids[issue.messageId]);
  const existingPages = engine
    ? (await engine.listPages()).map((page) => ({ slug: page.slug, title: page.title }))
    : [];
  const writtenPages: Array<{
    slug: string;
    messageId: string;
    rawPath: string;
    relatedSlugs: string[];
  }> = [];

  for (const issue of newIssues) {
    const compiled = buildNewsletterPage(issue);
    const relatedSlugs = matchExistingBrainPages(
      [
        ...compiled.entities.people,
        ...compiled.entities.companies,
        ...compiled.entities.products,
      ],
      existingPages,
    ).map((page) => page.slug);

    let content = compiled.content;
    if (relatedSlugs.length > 0) {
      const relatedSection = [
        '',
        '## Existing Brain Pages',
        ...relatedSlugs.map((slug) => `- ${slug}`),
      ].join('\n');
      content = content.replace('\n## Content\n', `${relatedSection}\n\n## Content\n`);
    }

    const rawPath = path.join(rawDir, `${issue.receivedAt.slice(0, 10)}-${issue.messageId}.json`);
    const compiledPath = path.join(compiledDir, compiled.path);
    mkdirSync(path.dirname(rawPath), { recursive: true });
    mkdirSync(path.dirname(compiledPath), { recursive: true });
    writeFileSync(rawPath, `${JSON.stringify(issue, null, 2)}\n`);
    writeFileSync(compiledPath, content);

    writtenPages.push({
      slug: compiled.slug,
      messageId: issue.messageId,
      rawPath,
      relatedSlugs,
    });
  }

  let imported = false;
  if (!compileOnly && writtenPages.length > 0) {
    const importArgs = [compiledDir];
    if (noEmbed) importArgs.push('--no-embed');
    await runImport(engine!, importArgs);
    await runExtract(engine!, ['all', '--dir', compiledDir]);

    for (const page of writtenPages) {
      const raw = JSON.parse(readFileSync(page.rawPath, 'utf8')) as Record<string, unknown>;
      await engine!.putRawData(page.slug, 'gmail-newsletter', raw);
      for (const relatedSlug of page.relatedSlugs) {
        try {
          await engine!.addLink(page.slug, relatedSlug, 'newsletter mention', 'mention');
        } catch {
          // Duplicate links are fine.
        }
      }
    }

    await engine!.logIngest({
      source_type: 'gmail-newsletter',
      source_ref: buildNewsletterQuery(label, backfill, days),
      pages_updated: writtenPages.map((page) => page.slug),
      summary: `Ingested ${writtenPages.length} newsletter issue(s)`,
    });
    imported = true;

    for (const page of writtenPages) {
      state.known_message_ids[page.messageId] = {
        slug: page.slug,
        ingested_at: new Date().toISOString(),
      };
    }
    state.last_run_at = new Date().toISOString();
    saveState(statePath, state);
  } else if (compileOnly && writtenPages.length > 0) {
    state.last_run_at = new Date().toISOString();
    saveState(statePath, state);
  }

  if (writtenPages.length === 0) {
    appendHeartbeat('newsletter_ingest', 'ok', {
      fetched: issues.length,
      new_issues: 0,
      imported: false,
      label,
      backfill,
      days: days || null,
    });
  } else {
    appendHeartbeat('newsletter_ingest', 'ok', {
      fetched: issues.length,
      new_issues: writtenPages.length,
      imported,
      label,
      backfill,
      days: days || null,
    });
  }

  const summary = {
    status: 'ok',
    query: buildNewsletterQuery(label, backfill, days),
    fetched: issues.length,
    new_issues: writtenPages.length,
    compiled_dir: path.resolve(compiledDir),
    raw_dir: path.resolve(rawDir),
    imported,
    pages: writtenPages.map((page) => page.slug),
  };

  if (jsonMode) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`Newsletter query: ${summary.query}`);
  console.log(`Fetched ${issues.length} labeled message(s); ${writtenPages.length} new issue(s) compiled.`);
  if (writtenPages.length > 0) {
    console.log(`Compiled markdown: ${summary.compiled_dir}`);
  }
  if (imported) {
    console.log('Imported into brain, extracted timeline/link data, and stored raw Gmail payloads.');
  } else if (compileOnly) {
    console.log('Compile-only mode: markdown written, import skipped, state not marked as ingested.');
  }
}
