/**
 * gbrain autopilot — Self-maintaining brain daemon.
 *
 * Runs: collect → sync → extract → enrich → embed → health check in a continuous loop.
 * Collectors: granola, gdrive, slack (script-based); newsletters, bookmarks, arxiv (engine-based).
 * Health-based adaptive scheduling. Best-effort per step.
 *
 * Usage:
 *   gbrain autopilot [--repo <path>] [--interval N] [--json] [--no-collect]
 *   gbrain autopilot --install [--repo <path>]
 *   gbrain autopilot --uninstall
 *   gbrain autopilot --status [--json]
 *
 * Collector config: ~/.gbrain/collectors.json
 *   { "granola": { "enabled": true }, "slack": { "enabled": false }, ... }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import type { BrainEngine } from '../core/engine.ts';

// --- Collector config ---

interface CollectorConfig {
  enabled: boolean;
  args?: string[];
}

interface CollectorsConfig {
  granola?: CollectorConfig;
  gdrive?: CollectorConfig;
  slack?: CollectorConfig;
  newsletters?: CollectorConfig;
  bookmarks?: CollectorConfig;
  arxiv?: CollectorConfig;
}

function loadCollectorsConfig(): CollectorsConfig {
  const configPath = join(process.env.HOME || '', '.gbrain', 'collectors.json');
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as CollectorsConfig;
  } catch {
    return {};
  }
}

/**
 * Resolve the scripts directory.
 * Priority: KBRAIN_SCRIPTS_DIR env → <binary_dir>/../scripts → cwd/scripts
 */
function resolveScriptsDir(): string {
  if (process.env.KBRAIN_SCRIPTS_DIR) return process.env.KBRAIN_SCRIPTS_DIR;
  const binDir = dirname(process.execPath);
  const binRelative = join(binDir, '..', 'scripts');
  if (existsSync(binRelative)) return binRelative;
  const cwdScripts = join(process.cwd(), 'scripts');
  if (existsSync(cwdScripts)) return cwdScripts;
  return binRelative; // best-effort fallback
}

/** Shell-escape a single argument for use inside single-quoted strings. */
function shEsc(s: string): string {
  return s.replace(/'/g, "'\\''");
}

async function runCollectors(engine: BrainEngine, repoPath: string, config: CollectorsConfig) {
  const scriptsDir = resolveScriptsDir();

  // Script-based collectors: write markdown to brain repo dir, sync picks them up
  const scriptCollectors: Array<{ name: keyof CollectorsConfig; script: string; defaultEnabled: boolean }> = [
    { name: 'granola', script: 'granola-sync.mjs', defaultEnabled: true },
    { name: 'gdrive',  script: 'gdrive-sync.mjs',  defaultEnabled: true },
    { name: 'slack',   script: 'slack-sync.mjs',   defaultEnabled: true },
  ];

  for (const { name, script, defaultEnabled } of scriptCollectors) {
    const cfg: CollectorConfig = config[name] ?? { enabled: defaultEnabled };
    if (!cfg.enabled) continue;

    const scriptPath = join(scriptsDir, script);
    if (!existsSync(scriptPath)) {
      console.log(`[collect:${name}] script not found at ${scriptPath}, skipping`);
      continue;
    }

    try {
      const extraArgs = (cfg.args ?? []).map(a => ` '${shEsc(a)}'`).join('');
      const cmd = `node '${shEsc(scriptPath)}' --brain-dir '${shEsc(repoPath)}'${extraArgs}`;
      const result = execSync(cmd, { timeout: 120_000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (result?.trim()) {
        const lastLine = result.trim().split('\n').pop() ?? '';
        console.log(`[collect:${name}] ${lastLine}`);
      } else {
        console.log(`[collect:${name}] done`);
      }
    } catch (e) {
      logError(`collect:${name}`, e);
    }
  }

  // Engine-based collectors: import directly into the brain DB
  // Pass --no-embed — autopilot's embed step handles stale embeddings

  // newsletters: default enabled (headless, needs only Gmail tokens)
  const newslettersCfg: CollectorConfig = config.newsletters ?? { enabled: true };
  if (newslettersCfg.enabled) {
    try {
      const { runIngestNewsletters } = await import('./ingest-newsletters.ts');
      await runIngestNewsletters(engine, ['--no-embed', ...(newslettersCfg.args ?? [])]);
      console.log('[collect:newsletters] done');
    } catch (e) {
      logError('collect:newsletters', e);
    }
  }

  // bookmarks: default disabled (requires Playwright browser session + URL list)
  const bookmarksCfg: CollectorConfig = config.bookmarks ?? { enabled: false };
  if (bookmarksCfg.enabled) {
    try {
      const { runIngestBookmarks } = await import('./ingest-bookmarks.ts');
      await runIngestBookmarks(engine, ['--no-embed', ...(bookmarksCfg.args ?? [])]);
      console.log('[collect:bookmarks] done');
    } catch (e) {
      logError('collect:bookmarks', e);
    }
  }

  // arxiv: default disabled (requires explicit paper IDs/URLs to be configured)
  const arxivCfg: CollectorConfig = config.arxiv ?? { enabled: false };
  if (arxivCfg.enabled) {
    try {
      const { runIngestArxiv } = await import('./ingest-arxiv.ts');
      await runIngestArxiv(engine, ['--no-embed', ...(arxivCfg.args ?? [])]);
      console.log('[collect:arxiv] done');
    } catch (e) {
      logError('collect:arxiv', e);
    }
  }
}

function parseArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function logError(phase: string, e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  const ts = new Date().toISOString().slice(0, 19);
  const line = `[${ts}] [${phase}] ERROR: ${msg}`;
  console.error(line);
  try {
    const logDir = join(process.env.HOME || '', '.gbrain');
    mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, 'autopilot.log'), line + '\n');
  } catch { /* best-effort */ }
}

export async function runAutopilot(engine: BrainEngine, args: string[]) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: gbrain autopilot [--repo <path>] [--interval N] [--json] [--no-collect]
       gbrain autopilot --install [--repo <path>]
       gbrain autopilot --uninstall
       gbrain autopilot --status [--json]

Self-maintaining brain daemon. Each cycle:
  0. Run collectors: granola, gdrive, slack, newsletters (+ bookmarks/arxiv if configured)
  1. Sync git repo
  2. Extract links & timeline
  2.5. Enrich entities from synced pages
  3. Embed stale pages
  4. Health check + adaptive interval

Collector config: ~/.gbrain/collectors.json
  { "granola": { "enabled": true }, "slack": { "enabled": false, "args": ["--days","3"] }, ... }
  Bookmarks/arxiv default to disabled — enable and pass args (e.g. --input or --ids-from).

Flags:
  --no-collect   Skip collector phase (sync-only mode)`);
    return;
  }

  if (args.includes('--install')) {
    await installDaemon(engine, args);
    return;
  }
  if (args.includes('--uninstall')) {
    uninstallDaemon();
    return;
  }
  if (args.includes('--status')) {
    showStatus(args.includes('--json'));
    return;
  }

  const repoPath = parseArg(args, '--repo') || await engine.getConfig('sync.repo_path');
  const baseInterval = parseInt(parseArg(args, '--interval') || '300', 10);
  const jsonMode = args.includes('--json');
  const noCollect = args.includes('--no-collect');

  if (!repoPath) {
    console.error('No repo path. Use --repo or run gbrain sync --repo first.');
    process.exit(1);
  }

  // Lock file to prevent concurrent instances (#14)
  const lockPath = join(process.env.HOME || '', '.gbrain', 'autopilot.lock');
  try {
    mkdirSync(join(process.env.HOME || '', '.gbrain'), { recursive: true });
    if (existsSync(lockPath)) {
      const stat = require('fs').statSync(lockPath);
      const ageMinutes = (Date.now() - stat.mtimeMs) / 60000;
      if (ageMinutes < 10) {
        console.error('Another autopilot instance is running (lock file is fresh). Exiting.');
        process.exit(0);
      }
      console.log('Stale lock file found (>10 min). Taking over.');
    }
    writeFileSync(lockPath, String(process.pid));
  } catch { /* best-effort */ }

  console.log(`Autopilot starting. Repo: ${repoPath}, interval: ${baseInterval}s${noCollect ? ', collect: disabled' : ''}`);

  // Signal handling + lock cleanup
  let stopping = false;
  let wakeupResolve: (() => void) | null = null;
  const cleanup = () => { try { require('fs').unlinkSync(lockPath); } catch {} };
  process.on('exit', cleanup);
  const handleStop = (sig: string) => {
    stopping = true;
    console.log(`Autopilot stopping (${sig}).`);
    wakeupResolve?.(); // interrupt the inter-cycle sleep
  };
  process.on('SIGTERM', () => handleStop('SIGTERM'));
  process.on('SIGINT', () => handleStop('SIGINT'));

  let consecutiveErrors = 0;

  while (!stopping) {
    const cycleStart = Date.now();
    let cycleOk = true;

    // DB health check (reconnect if needed)
    try {
      await engine.getConfig('version');
    } catch {
      try {
        await engine.disconnect();
        await (engine as any).connect?.();
      } catch (e) { logError('reconnect', e); }
    }

    // 0. Collectors (granola, gdrive, slack, newsletters, bookmarks, arxiv)
    if (!noCollect) {
      const collectorsConfig = loadCollectorsConfig();
      try {
        await runCollectors(engine, repoPath, collectorsConfig);
      } catch (e) { logError('collectors', e); cycleOk = false; }
    }

    // 1. Sync
    let syncedSlugs: string[] = [];
    try {
      const { performSync } = await import('./sync.ts');
      // noEnrich: true — step 2.5 handles enrichment so sync doesn't double-enrich
      const result = await performSync(engine, { repoPath, noEmbed: true, noEnrich: true });
      if (result.status === 'synced') {
        console.log(`[sync] +${result.added} ~${result.modified} -${result.deleted}`);
        syncedSlugs = result.pagesAffected;
      }
    } catch (e) { logError('sync', e); cycleOk = false; }

    // 2. Extract (full brain, incremental dedup handles repeats)
    try {
      const { runExtract } = await import('./extract.ts');
      await runExtract(engine, ['all', '--dir', repoPath]);
    } catch (e) { logError('extract', e); cycleOk = false; }

    // 2.5. Enrich entities from newly synced/modified pages
    try {
      const { extractAndEnrich } = await import('../core/enrichment-service.ts');
      for (const slug of syncedSlugs) {
        try {
          const page = await engine.getPage(slug);
          if (page) {
            const text = [page.compiled_truth, page.timeline].filter(Boolean).join('\n');
            await extractAndEnrich(engine, text, slug);
          }
        } catch { /* per-page errors don't stop the batch */ }
      }
    } catch (e) { logError('enrich', e); cycleOk = false; }

    // 2.7. Compile: write frontmatter-inferred links back to vault as [[wikilinks]]
    // Runs every cycle (not just when pages synced) because enrich may have created
    // new entity pages on the prior cycle, making previously-missing links storable.
    try {
      const { runCompile } = await import('./compile.ts');
      const compileResult = await runCompile(engine, ['--repo', repoPath]);
      if (compileResult.pagesUpdated > 0 || compileResult.pagesCleared > 0) {
        console.log(`[compile] ${compileResult.pagesUpdated} pages updated, ${compileResult.pagesCleared} cleared, ${compileResult.linksWritten} links written`);
      }
    } catch (e) { logError('compile', e); cycleOk = false; }

    // 3. Embed stale
    try {
      const { runEmbed } = await import('./embed.ts');
      await runEmbed(engine, ['--stale']);
    } catch (e) { logError('embed', e); cycleOk = false; }

    // 4. Health check + adaptive interval
    let interval = baseInterval;
    try {
      const health = await engine.getHealth();
      const score = (health as any).brain_score ?? 50;
      interval = score >= 90 ? baseInterval * 2
               : score < 70 ? Math.max(Math.floor(baseInterval / 2), 60)
               : baseInterval;

      const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(0);
      const line = `[cycle] score=${score} elapsed=${elapsed}s next=${interval}s`;
      if (jsonMode) {
        process.stderr.write(JSON.stringify({ event: 'cycle', brain_score: score, elapsed_s: Number(elapsed), next_s: interval }) + '\n');
      } else {
        console.log(line);
      }
    } catch (e) { logError('health', e); }

    if (cycleOk) {
      consecutiveErrors = 0;
    } else {
      consecutiveErrors++;
      if (consecutiveErrors >= 5) {
        console.error('5 consecutive cycle failures. Stopping autopilot.');
        process.exit(1);
      }
    }

    // Wait for next cycle (interruptible by SIGTERM/SIGINT)
    if (!stopping) {
      await Promise.race([
        new Promise<void>(r => setTimeout(r, interval * 1000)),
        new Promise<void>(r => { wakeupResolve = r; }),
      ]);
    }
  }

  // Clean shutdown: flush PGLite WAL before exiting
  try {
    await engine.disconnect();
    console.log('Autopilot stopped cleanly.');
  } catch { /* best-effort */ }
  cleanup();
  process.exit(0);
}

// --- Install/Uninstall ---

function plistPath(): string {
  return join(process.env.HOME || '', 'Library', 'LaunchAgents', 'com.gbrain.autopilot.plist');
}

async function installDaemon(engine: BrainEngine, args: string[]) {
  const repoPath = parseArg(args, '--repo') || await engine.getConfig('sync.repo_path');
  if (!repoPath) {
    console.error('No repo path. Use --repo or run gbrain sync --repo first.');
    process.exit(1);
  }

  const home = process.env.HOME || '';
  const gbrainDir = join(home, '.gbrain');
  mkdirSync(gbrainDir, { recursive: true });

  // Write a wrapper script that sources the user's shell profile for API keys
  // instead of baking secrets into plist/crontab (#2: no plaintext keys in config files)
  const wrapperPath = join(gbrainDir, 'autopilot-run.sh');
  const gbrainPath = process.execPath;
  // Shell-escape values to prevent command injection (#1)
  const safeRepoPath = repoPath.replace(/'/g, "'\\''");
  const safeGbrainPath = gbrainPath.replace(/'/g, "'\\''");
  const wrapper = `#!/bin/bash
# Auto-generated by gbrain autopilot --install
# Sources shell profile for API keys, then runs autopilot
source ~/.zshrc 2>/dev/null || source ~/.bashrc 2>/dev/null || true
exec '${safeGbrainPath}' autopilot --repo '${safeRepoPath}'
`;
  writeFileSync(wrapperPath, wrapper, { mode: 0o755 });

  if (process.platform === 'darwin') {
    // macOS: launchd plist — runs wrapper script (no secrets in plist)
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.gbrain.autopilot</string>
  <key>ProgramArguments</key><array>
    <string>${escapeXml(wrapperPath)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(home)}/.gbrain/autopilot.log</string>
  <key>StandardErrorPath</key><string>${escapeXml(home)}/.gbrain/autopilot.err</string>
</dict>
</plist>`;

    try {
      const agentsDir = join(home, 'Library', 'LaunchAgents');
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(plistPath(), plist);
      execSync(`launchctl load "${plistPath()}"`, { stdio: 'pipe' });
      console.log(`Installed launchd service: com.gbrain.autopilot`);
      console.log(`  Repo: ${repoPath}`);
      console.log(`  Log: ~/.gbrain/autopilot.log`);
      console.log(`  Uninstall: gbrain autopilot --uninstall`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('EACCES') || msg.includes('Permission')) {
        console.error(`Permission denied writing plist. Try: mkdir -p ~/Library/LaunchAgents`);
      } else {
        console.error(`Failed to install: ${msg}`);
      }
      process.exit(1);
    }
  } else {
    // Linux/WSL: crontab — runs wrapper script (no secrets in crontab)
    const safeWrapperPath = wrapperPath.replace(/'/g, "'\\''");
    const cronLine = `*/5 * * * * '${safeWrapperPath}' >> '${home.replace(/'/g, "'\\''")}/.gbrain/autopilot.log' 2>&1`;
    try {
      const existing = execSync('crontab -l 2>/dev/null || true', { encoding: 'utf-8' });
      if (existing.includes('gbrain autopilot') || existing.includes('autopilot-run.sh')) {
        console.log('Crontab entry already exists. Remove with: gbrain autopilot --uninstall');
        return;
      }
      // Use a temp file instead of echo pipe to avoid shell escaping issues (#1)
      const tmpFile = join(gbrainDir, 'crontab.tmp');
      writeFileSync(tmpFile, existing.trimEnd() + '\n' + cronLine + '\n');
      execSync(`crontab '${tmpFile.replace(/'/g, "'\\''")}'`, { stdio: 'pipe' });
      try { require('fs').unlinkSync(tmpFile); } catch {}
      console.log('Installed crontab entry for gbrain autopilot (every 5 minutes)');
      console.log(`  Uninstall: gbrain autopilot --uninstall`);
    } catch (e: unknown) {
      console.error(`Failed to install crontab: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
  }
}

function uninstallDaemon() {
  const home = process.env.HOME || '';
  const wrapperPath = join(home, '.gbrain', 'autopilot-run.sh');

  if (process.platform === 'darwin') {
    try {
      execSync(`launchctl unload "${plistPath()}" 2>/dev/null || true`, { stdio: 'pipe' });
      if (existsSync(plistPath())) {
        const { unlinkSync } = require('fs');
        unlinkSync(plistPath());
      }
      if (existsSync(wrapperPath)) {
        require('fs').unlinkSync(wrapperPath);
      }
      console.log('Uninstalled launchd service: com.gbrain.autopilot');
    } catch (e: unknown) {
      console.error(`Failed to uninstall: ${e instanceof Error ? e.message : e}`);
    }
  } else {
    try {
      const existing = execSync('crontab -l 2>/dev/null || true', { encoding: 'utf-8' });
      const filtered = existing.split('\n').filter(l =>
        !l.includes('gbrain autopilot') && !l.includes('autopilot-run.sh')
      ).join('\n');
      const tmpFile = join(home, '.gbrain', 'crontab.tmp');
      writeFileSync(tmpFile, filtered);
      execSync(`crontab '${tmpFile.replace(/'/g, "'\\''")}' 2>/dev/null || true`, { stdio: 'pipe' });
      try { require('fs').unlinkSync(tmpFile); } catch {}
      if (existsSync(wrapperPath)) {
        require('fs').unlinkSync(wrapperPath);
      }
      console.log('Removed crontab entry for gbrain autopilot');
    } catch (e: unknown) {
      console.error(`Failed to uninstall: ${e instanceof Error ? e.message : e}`);
    }
  }
}

function showStatus(json: boolean) {
  const logFile = join(process.env.HOME || '', '.gbrain', 'autopilot.log');
  let lastLine = '';
  try {
    const content = readFileSync(logFile, 'utf-8');
    const lines = content.trim().split('\n');
    lastLine = lines[lines.length - 1] || '';
  } catch { /* no log */ }

  let installed = false;
  if (process.platform === 'darwin') {
    installed = existsSync(plistPath());
  } else {
    try {
      const crontab = execSync('crontab -l 2>/dev/null || true', { encoding: 'utf-8' });
      installed = crontab.includes('gbrain autopilot');
    } catch { /* no crontab */ }
  }

  if (json) {
    console.log(JSON.stringify({ installed, last_log: lastLine }));
  } else {
    console.log(`Autopilot: ${installed ? 'installed' : 'not installed'}`);
    if (lastLine) console.log(`Last log: ${lastLine}`);
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
