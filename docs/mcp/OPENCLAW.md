# Connect GBrain to OpenClaw

OpenClaw is the primary agent platform for GBrain. It runs as a Claude Code-based
agent process, which means GBrain connects via stdio — the same way any MCP server
does in Claude Code, Cursor, or Windsurf. No HTTP server, no tunnel, no token needed.

## Register the MCP Server

```bash
claude mcp add gbrain -- gbrain serve
```

This tells OpenClaw to spawn `gbrain serve` as a stdio subprocess on startup.
All 32 GBrain tools are immediately available.

If you installed GBrain via the `openclaw.plugin.json` bundle manifest, the MCP
registration is handled automatically — `gbrain serve` is already declared under
`mcpServers` in that file and OpenClaw loads it on install.

## Verify

Confirm the tools are visible:

```bash
claude mcp list
```

You should see `gbrain` in the list. Then ask OpenClaw:

```
List my GBrain MCP tools
```

You should see all 32 tools: `get_page`, `put_page`, `search`, `query`,
`enrich_entity`, `extract_entities`, and 26 more.

For a functional check:

```
Search my brain for [any topic you've imported]
```

If results come back, the brain is live.

## Brain-First Lookup Pattern

The `brain-ops` skill enforces the brain-first protocol. OpenClaw checks the brain
before any external API call:

1. `search` — keyword search for existing pages
2. `query` — hybrid vector + keyword search for context
3. `get_page` — read the full page if you know the slug
4. Check backlinks and timeline for the entity

**To activate:** paste the `brain-ops` skill into your OpenClaw AGENTS.md or
system prompt:

```
Read skills/brain-ops/SKILL.md before any brain interaction.
```

Or reference it by URL if running a hosted agent:

```
https://raw.githubusercontent.com/garrytan/gbrain/master/skills/brain-ops/SKILL.md
```

## Signal Detector

The `signal-detector` skill fires on every inbound message to capture original
thinking and entity mentions. It runs as a cheap sub-agent in parallel — it never
blocks the main response.

**What it captures (equal priority):**
1. Original thinking — the user's ideas, observations, theses (exact phrasing)
2. Entity mentions — people, companies, media references

**To activate:** inject the signal-detector into your OpenClaw agent:

```
Read skills/signal-detector/SKILL.md. Fire this on every inbound message.
```

This wires up the always-on ambient capture loop. Every conversation enriches the brain.

**Verify it's working:** after a few messages mentioning people or companies, run:

```
gbrain search "[person you mentioned]"
```

A page should exist. If it does, signal-detector is working.

## Skill Bundle

The `openclaw.plugin.json` manifest pre-loads 7 skills automatically:

| Skill | Purpose |
|-------|---------|
| ingest | Route ingestion requests |
| query | Brain-first search + retrieval |
| maintain | Backlink + lint repair |
| enrich | Entity enrichment loop |
| briefing | Morning brief generation |
| migrate | Engine migration |
| setup | First-run setup wizard |

Load `signal-detector` and `brain-ops` separately (they're in `skills/` and
not yet in the plugin manifest) for full always-on capture.

## Remove

```bash
claude mcp remove gbrain
```

## Troubleshooting

**"gbrain: command not found"**
Run `bun link` in the gbrain directory, or use the full path:
```bash
claude mcp add gbrain -- /path/to/gbrain serve
```

**Tools not appearing after registration**
Restart OpenClaw — the MCP server is spawned at startup, not hot-reloaded.

**Search returns empty results**
Run `gbrain import ./vault/` (or wherever your markdown lives) to populate the brain.
