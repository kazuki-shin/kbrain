# Connect GBrain to Hermes

[Hermes Agent](https://github.com/NousResearch/hermes-agent) is an alternative
orchestrator with built-in multi-platform messaging (Telegram, Discord, Slack,
WhatsApp, Signal, Email) and a credential gateway for Gmail, Calendar, Drive, and
Contacts. GBrain connects as a stdio MCP server.

## Transport: stdio only (HTTP not yet available)

| Mode | Status | Use Case |
|------|--------|----------|
| stdio (local) | **Supported** | Hermes running on same machine as gbrain |
| HTTP (remote) | **Not yet built** | Hermes on Railway/cloud pointing to remote brain |

`gbrain serve --http` is planned (see TODOS.md) but not yet implemented. Until
then, Hermes must run on the same machine as GBrain to use stdio transport.

For remote deployments, the workaround is to run GBrain behind a custom HTTP
wrapper + ngrok. See [DEPLOY.md](DEPLOY.md) for that setup.

## Register GBrain in Hermes config.yaml

In your Hermes `config.yaml`, add GBrain under the `mcp_servers` (or equivalent)
section. The exact key depends on your Hermes version — check
[hermes-agent docs](https://github.com/NousResearch/hermes-agent) for the
current schema:

```yaml
mcp_servers:
  gbrain:
    command: gbrain
    args:
      - serve
    env:
      # Pass env vars gbrain needs (if not already in shell profile)
      # OPENAI_API_KEY: "sk-..."
      # DATABASE_URL: "postgresql://..."
```

If Hermes uses a `tools` or `plugins` block instead:

```yaml
tools:
  - type: mcp
    name: gbrain
    transport: stdio
    command: gbrain
    args: [serve]
```

After saving, restart the Hermes daemon:

```bash
hermes restart   # or: hermes agent restart
```

## Verify

In any Hermes-connected messaging channel (Telegram, Discord, etc.), send:

```
@agent list your brain tools
```

You should see the 32 GBrain tools. For a functional check:

```
@agent search my brain for [any topic you've imported]
```

Results confirm the brain is live and MCP routing works through the messaging gateway.

## Brain-First Lookup Pattern

The `brain-ops` skill enforces the brain-first protocol. Add it to your Hermes
agent system prompt:

```
Read skills/brain-ops/SKILL.md before any brain interaction.
```

Or inline the key rule:

```
Before researching any person, company, or topic via external APIs:
1. Call search("[name]") via GBrain MCP
2. Call query("natural question about [name]") for hybrid context
3. Only call external APIs to fill gaps, not to start from scratch
```

This pattern works the same whether the conversation arrives via Telegram, Slack,
Discord, or any other Hermes-connected channel.

## Signal Detector via Hermes Messaging

The signal-detector fires on every inbound message. Wire it up in your Hermes
system prompt:

```
Read skills/signal-detector/SKILL.md. Fire this on every inbound message.
Run it as a background sub-agent — never block the main response.
```

This means every Telegram/Discord/Slack message that mentions a person, company,
or contains original thinking will silently enrich the brain. The summary log line
(`Signals: 1 idea, 2 entities`) lets you debug what was captured.

## Credential Gateway (ClawVisor vs Hermes Built-in)

Hermes has its own credential gateway for Gmail, Calendar, Contacts, and messaging.
Configure OAuth credentials in `config.yaml` under `services`:

```yaml
services:
  google:
    client_id: "YOUR_CLIENT_ID"
    client_secret: "YOUR_CLIENT_SECRET"
    scopes:
      - gmail.readonly
      - calendar.events
      - contacts.readonly
  telegram:
    bot_token: "YOUR_BOT_TOKEN"
```

This credential gateway is the Hermes equivalent of ClawVisor — the agent accesses
Gmail, Calendar, and Contacts through the gateway's tool system, not directly.

See [credential-gateway.md](../integrations/credential-gateway.md) for
full EA workflow setup (email triage, calendar prep, contact enrichment).

## Scheduled Automations

Hermes's scheduled automations can run GBrain workflows on a cron schedule:

```yaml
automations:
  - name: morning-brain-sync
    schedule: "0 6 * * *"   # 6am daily
    prompt: |
      Sync the brain and generate a morning briefing.
      Use GBrain sync_brain, then read skills/briefing/SKILL.md.

  - name: nightly-enrichment
    schedule: "0 2 * * *"   # 2am nightly
    prompt: |
      Run overnight enrichment: enrich all thin entity pages,
      fix broken back-links, consolidate duplicate pages.
```

These automations use the same GBrain MCP tools available in interactive sessions.

## Troubleshooting

**Hermes can't find `gbrain` binary**
Use the full path in config.yaml:
```yaml
command: /path/to/gbrain   # find it with: which gbrain
```

**MCP tools not listed after restart**
Check Hermes daemon logs — gbrain may have failed to start due to missing env vars.
Ensure `OPENAI_API_KEY` and `DATABASE_URL` are in the env block or exported in
the shell profile Hermes uses.

**Messaging channel not routing to GBrain tools**
Confirm the Hermes agent session has the gbrain MCP server in scope. Some Hermes
versions require explicitly enabling tool servers per agent session.

**Remote Hermes (Railway/Fly.io) can't reach GBrain**
This requires HTTP transport, which is not yet built into GBrain. Options:
- Run GBrain on the same host as Hermes (PGLite or Postgres)
- Use the custom HTTP wrapper pattern in [DEPLOY.md](DEPLOY.md) with ngrok or Tailscale
