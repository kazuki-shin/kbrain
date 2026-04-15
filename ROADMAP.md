# kbrain Roadmap

Personal fork of GBrain. The product is a compounding personal knowledge base — not a
scraper, not a bookmark manager. Every input type feeds the same brain. Obsidian is the
human interface. GBrain is the engine underneath.

## Existing System

A separate repo contains the current pipeline:

- **Playwright-based X scraper** — fetches bookmarks, posts, and same-author thread
  continuations using a real browser session (free, no API key)
- **raw/** — local ingest artifacts grouped by source type
- **compile scripts** — normalize raw data into Obsidian-ready markdown
- **vault/** — compiled markdown wiki, the main artifact
- **Obsidian** — frontend for browsing, linking, reviewing

This pipeline stays as-is. kbrain extends it downstream.

## How kbrain Fits

```
Playwright scraper → raw/ → compile scripts → vault/
                                                 ↓
                                          kbrain import vault/
                                          kbrain sync --watch
                                                 ↓
                                          vector search, hybrid RAG,
                                          MCP server, enrichment,
                                          cross-linking, agent memory
```

The scraper + compile pipeline handles ingest. kbrain handles everything after:
semantic search, auto-enrichment, cross-linking, agent memory via MCP.

## Vault Compatibility

GBrain imports standard markdown with optional YAML frontmatter. The two-zone pattern
(compiled truth above `---`, timeline below) is optional — if absent, all content is
treated as compiled truth. Obsidian-style wiki links, tags, and frontmatter all work.

Minimum viable file:
```markdown
---
title: Some Topic
tags: [ai, research]
---

Content here.
```

Even a plain markdown file with no frontmatter imports fine — title is inferred from
filename, type from directory.

## Phases

### Phase 1: Wire It Up (Week 1)

**Goal:** Existing vault is queryable and available to Claude Code via MCP.

- [ ] `kbrain import ~/path-to-vault/` — index existing compiled notes
- [ ] `kbrain sync --repo ~/path-to-vault --watch` — live sync as compile scripts update
- [ ] Add kbrain as MCP server in `~/.claude/server.json`:
  ```json
  { "mcpServers": { "kbrain": { "command": "gbrain", "args": ["serve"] } } }
  ```
- [ ] Set `OPENAI_API_KEY` for vector embeddings (optional, keyword search works without)
- [ ] Run `kbrain embed --stale` to generate initial embeddings
- [ ] Verify: `kbrain query "test question"` returns relevant results

**Daily loop after Phase 1:**
```
morning:  run refresh:x:cluster (existing scraper)
          kbrain auto-syncs vault/
workday:  Claude Code queries brain via MCP as you work
evening:  kbrain query "what did I learn today?"
```

### Phase 2: Auto-Enrichment (Weeks 2-3)

**Goal:** The brain starts compounding on its own.

- [ ] Enable signal detector skill — captures entities and ideas on every agent interaction
- [ ] Enable brain-ops skill — agent checks brain before going to the web
- [ ] Set up cron: `kbrain embed --stale` every 15 min
- [ ] Set up cron: `kbrain sync --repo ~/path-to-vault` every 15 min
- [ ] Run `kbrain doctor` to verify health
- [ ] Test cross-linking: bookmark an X post about a person, verify their page gets updated

**What changes:** Every X post you bookmark about a person now cross-links to everything
else you know about them. Past research stops being forgotten.

### Phase 3: New Input Types (Weeks 4-6)

Add inputs in order of personal leverage. Each follows the same pattern:
scrape → raw/ → compile → vault/ → kbrain syncs automatically.

**Priority order:**

1. **Personal notes**
   - Import Apple Notes, other markdown outside Obsidian
   - Highest ROI — this is your own thinking
   - May just be a directory copy + compile step

2. **Hacker News**
   - Saved stories + comment threads
   - Simple scraper, high signal for technical research
   - Good candidate for Playwright reuse

3. **YouTube / podcast transcripts**
   - `yt-dlp` extracts transcripts, kbrain's `transcription.ts` handles audio via Whisper
   - Long-form thinking from people you follow
   - Compile into per-episode or per-speaker notes

4. **ArXiv / papers**
   - PDF → markdown pipeline
   - kbrain can read PDFs directly
   - Compile into concept notes with key findings

5. **RSS / blogs**
   - Long-form writing from people you follow
   - Simple fetch + readability extraction
   - Compile into per-author or per-topic notes

6. **GitHub repos / discussions**
   - READMEs, issues, discussions
   - Technical landscape tracking

### Phase 4: kbrain-Native Features (Weeks 7-10)

Features to build in this fork that upstream GBrain doesn't have.

- [ ] **`kbrain ingest:bookmarks`** — first-class command wrapping Playwright bookmark scraping.
      Generalizes the X scraper pattern so new source types plug in the same way.

- [ ] **Obsidian write-back** — kbrain indexes Obsidian but doesn't write back today.
      Build a mode where auto-enrichments (new links, entity pages, timeline entries)
      get written as Obsidian-compatible markdown into vault/.

- [ ] **Research mode** — ask a question, kbrain searches the KB, identifies gaps, goes
      to the web to fill them, files findings back into the brain. The killer feature
      from the original vision doc.

- [ ] **Weekly digest** — auto-generated briefing: what's new in your brain this week,
      what connections emerged, what's stale.

- [ ] **Collection-as-lens** — define named research collections (e.g., "ai-agents",
      "market-landscape"). Each collection is a filtered view with its own hub note
      auto-maintained in vault/.

### Phase 5: Daily Operating System (Weeks 10+)

The brain becomes the foundation for daily workflows.

- [ ] **Morning brief** — auto-generated from overnight brain activity + calendar
- [ ] **Meeting prep** — query brain for context on people/companies before any call
- [ ] **Decision log** — every major decision linked to the research that informed it
- [ ] **Agent memory** — all agents (Claude Code, others) share the brain as persistent
      context. Your coding agent knows your research. Your research agent knows your code.

## Daily Habit

The system only compounds if you use it. Minimal daily commitment:

| When | What | Time |
|---|---|---|
| Morning | Run scraper (or let cron handle it) | 0-2 min |
| During work | Ask Claude Code questions — it queries brain via MCP | 0 min (passive) |
| When interesting | Bookmark on X, or drop a note in vault/ | 10 sec |
| Weekly | `kbrain stats` — check growth, find stale areas | 5 min |

You bookmark things and ask questions. The system does the librarian work.

## Principles

1. **The product is the knowledge base, not the scraper.** Input types come and go.
   The compiled brain is the asset.
2. **Explicit over hidden.** Prefer navigable markdown over opaque app memory.
3. **Provenance always.** Every compiled note traces back to a source.
4. **Collections are lenses.** Start narrow, merge stable insights upward into hubs.
5. **Feed outputs back.** Useful agent outputs become first-class brain notes.
6. **Daily use or it dies.** A knowledge base you don't query daily is a graveyard.
