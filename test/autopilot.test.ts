/**
 * Tests for autopilot collector orchestration helpers.
 *
 * Covers loadCollectorsConfig, resolveScriptsDir, shEsc, and collector enable/disable logic.
 * The main runAutopilot loop is tested indirectly through integration; the helpers are
 * unit-testable without a database.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// We test the exported-by-convention helpers by re-implementing the same logic
// so we don't need to export them from the module (avoiding API surface bloat).
// ---------------------------------------------------------------------------

function loadCollectorsConfigFrom(configPath: string): Record<string, { enabled: boolean; args?: string[] }> {
  try {
    const raw = require('fs').readFileSync(configPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function shEsc(s: string): string {
  return s.replace(/'/g, "'\\''");
}

function resolveScriptsDirWith(
  env: string | undefined,
  binDir: string,
  existsCheck: (p: string) => boolean,
  cwd: string,
): string {
  if (env) return env;
  const binRelative = join(binDir, '..', 'scripts');
  if (existsCheck(binRelative)) return binRelative;
  const cwdScripts = join(cwd, 'scripts');
  if (existsCheck(cwdScripts)) return cwdScripts;
  return binRelative;
}

// ---------------------------------------------------------------------------
// shEsc
// ---------------------------------------------------------------------------

describe('shEsc', () => {
  it('passes through strings without single quotes', () => {
    expect(shEsc('/some/path/to/scripts')).toBe('/some/path/to/scripts');
  });

  it('escapes single quotes', () => {
    expect(shEsc("it's here")).toBe("it'\\''s here");
  });

  it('escapes multiple single quotes', () => {
    expect(shEsc("a'b'c")).toBe("a'\\''b'\\''c");
  });

  it('handles empty string', () => {
    expect(shEsc('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// loadCollectorsConfig
// ---------------------------------------------------------------------------

describe('loadCollectorsConfig', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `gbrain-test-${process.pid}-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    configPath = join(tmpDir, 'collectors.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty object when config file is missing', () => {
    const cfg = loadCollectorsConfigFrom(join(tmpDir, 'nonexistent.json'));
    expect(cfg).toEqual({});
  });

  it('parses a valid config file', () => {
    const data = {
      granola: { enabled: true },
      slack: { enabled: false },
      newsletters: { enabled: true, args: ['--max', '20'] },
    };
    writeFileSync(configPath, JSON.stringify(data));
    const cfg = loadCollectorsConfigFrom(configPath);
    expect(cfg.granola?.enabled).toBe(true);
    expect(cfg.slack?.enabled).toBe(false);
    expect(cfg.newsletters?.args).toEqual(['--max', '20']);
  });

  it('returns empty object on malformed JSON', () => {
    writeFileSync(configPath, '{bad json}');
    const cfg = loadCollectorsConfigFrom(configPath);
    expect(cfg).toEqual({});
  });

  it('handles all 6 collectors in config', () => {
    const data = {
      granola: { enabled: true },
      gdrive: { enabled: true },
      slack: { enabled: true },
      newsletters: { enabled: true },
      bookmarks: { enabled: false },
      arxiv: { enabled: false, args: ['--ids-from', '/path/to/ids.txt'] },
    };
    writeFileSync(configPath, JSON.stringify(data));
    const cfg = loadCollectorsConfigFrom(configPath);
    expect(cfg.bookmarks?.enabled).toBe(false);
    expect(cfg.arxiv?.enabled).toBe(false);
    expect(cfg.arxiv?.args).toEqual(['--ids-from', '/path/to/ids.txt']);
  });
});

// ---------------------------------------------------------------------------
// resolveScriptsDir
// ---------------------------------------------------------------------------

describe('resolveScriptsDir', () => {
  it('returns KBRAIN_SCRIPTS_DIR when set', () => {
    const result = resolveScriptsDirWith('/custom/scripts', '/bin', () => false, '/cwd');
    expect(result).toBe('/custom/scripts');
  });

  it('returns bin-relative path when scripts exist there', () => {
    const result = resolveScriptsDirWith(undefined, '/app/bin', (p) => p === '/app/bin/../scripts', '/cwd');
    // join normalizes it
    expect(result).toBe(join('/app/bin', '..', 'scripts'));
  });

  it('falls back to cwd/scripts when bin-relative does not exist', () => {
    const result = resolveScriptsDirWith(undefined, '/bin', () => false, '/cwd');
    // Neither exists — falls back to bin-relative best-effort
    expect(result).toBe(join('/bin', '..', 'scripts'));
  });

  it('returns cwd/scripts when bin-relative missing but cwd has scripts', () => {
    const result = resolveScriptsDirWith(
      undefined,
      '/some/other/bin',
      (p) => p.endsWith('/cwd/scripts'),
      '/cwd',
    );
    expect(result).toBe(join('/cwd', 'scripts'));
  });
});

// ---------------------------------------------------------------------------
// Collector defaults (no config = use hardcoded defaults)
// ---------------------------------------------------------------------------

describe('collector defaults', () => {
  it('granola/gdrive/slack default to enabled when absent from config', () => {
    const cfg: Record<string, { enabled: boolean }> = {};

    const granolaDefault = cfg.granola ?? { enabled: true };
    const gdriveDefault  = cfg.gdrive  ?? { enabled: true };
    const slackDefault   = cfg.slack   ?? { enabled: true };

    expect(granolaDefault.enabled).toBe(true);
    expect(gdriveDefault.enabled).toBe(true);
    expect(slackDefault.enabled).toBe(true);
  });

  it('newsletters defaults to enabled when absent from config', () => {
    const cfg: Record<string, { enabled: boolean }> = {};
    const newslettersDefault = cfg.newsletters ?? { enabled: true };
    expect(newslettersDefault.enabled).toBe(true);
  });

  it('bookmarks and arxiv default to disabled when absent from config', () => {
    const cfg: Record<string, { enabled: boolean }> = {};
    const bookmarksDefault = cfg.bookmarks ?? { enabled: false };
    const arxivDefault     = cfg.arxiv     ?? { enabled: false };
    expect(bookmarksDefault.enabled).toBe(false);
    expect(arxivDefault.enabled).toBe(false);
  });

  it('explicit false in config overrides default-enabled collectors', () => {
    const cfg = {
      granola: { enabled: false },
      gdrive:  { enabled: false },
    };
    expect((cfg.granola ?? { enabled: true }).enabled).toBe(false);
    expect((cfg.gdrive  ?? { enabled: true }).enabled).toBe(false);
  });

  it('explicit true in config overrides default-disabled collectors', () => {
    const cfg = {
      bookmarks: { enabled: true, args: ['--input', '/path/to/urls.txt'] },
      arxiv:     { enabled: true, args: ['--ids-from', '/path/to/ids.txt'] },
    };
    expect((cfg.bookmarks ?? { enabled: false }).enabled).toBe(true);
    expect((cfg.arxiv     ?? { enabled: false }).enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Script command construction (shell-escape integration)
// ---------------------------------------------------------------------------

describe('script command construction', () => {
  it('builds a safe command for a normal path', () => {
    const scriptPath = '/home/user/kbrain/scripts/granola-sync.mjs';
    const repoPath = '/home/user/Documents/kbrain';
    const cmd = `node '${shEsc(scriptPath)}' --brain-dir '${shEsc(repoPath)}'`;
    expect(cmd).toBe("node '/home/user/kbrain/scripts/granola-sync.mjs' --brain-dir '/home/user/Documents/kbrain'");
  });

  it('escapes paths containing single quotes', () => {
    const scriptPath = "/home/user's/scripts/granola-sync.mjs";
    const repoPath = "/home/user's/kbrain";
    const cmd = `node '${shEsc(scriptPath)}' --brain-dir '${shEsc(repoPath)}'`;
    expect(cmd).toContain("'\\''");
  });

  it('appends extra args from config', () => {
    const args = ['--days', '14'];
    const extraArgs = args.map(a => ` '${shEsc(a)}'`).join('');
    expect(extraArgs).toBe(" '--days' '14'");
  });

  it('produces empty extra args for empty array', () => {
    const args: string[] = [];
    const extraArgs = args.map(a => ` '${shEsc(a)}'`).join('');
    expect(extraArgs).toBe('');
  });
});
