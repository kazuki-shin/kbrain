import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import type { NewsletterIssue } from './compiler.ts';

interface GoogleTokenFile {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type?: string;
  scope?: string;
  client_id?: string;
  client_secret?: string;
}

interface GmailMessageRef {
  id: string;
  threadId: string;
}

interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  body?: {
    data?: string;
    attachmentId?: string;
    size?: number;
  };
  headers?: Array<{ name: string; value: string }>;
  parts?: GmailMessagePart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
}

export interface FetchNewsletterOpts {
  authuser?: string;
  label?: string;
  labelId?: string;
  backfill?: boolean;
  days?: number;
  maxMessages?: number;
  tokenPath?: string;
}

interface GmailLabel {
  id: string;
  name: string;
  type?: string;
}

function defaultTokenPath(): string {
  return `${homedir()}/.gbrain/google-tokens.json`;
}

function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, 'base64').toString('utf8');
}

function loadTokenFile(tokenPath: string): GoogleTokenFile {
  if (!existsSync(tokenPath)) {
    throw new Error(`Google token file not found: ${tokenPath}`);
  }
  return JSON.parse(readFileSync(tokenPath, 'utf8')) as GoogleTokenFile;
}

function saveTokenFile(tokenPath: string, tokens: GoogleTokenFile): void {
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
}

async function refreshAccessToken(tokenPath: string, tokens: GoogleTokenFile): Promise<GoogleTokenFile> {
  const clientId = process.env.GOOGLE_CLIENT_ID || tokens.client_id;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || tokens.client_secret;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN || tokens.refresh_token;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing Google OAuth credentials. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN or store them in ~/.gbrain/google-tokens.json.');
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    throw new Error(`Google token refresh failed: ${response.status} ${await response.text()}`);
  }

  const refreshed = await response.json() as {
    access_token: string;
    expires_in: number;
    token_type?: string;
    scope?: string;
  };

  const updated: GoogleTokenFile = {
    ...tokens,
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    access_token: refreshed.access_token,
    token_type: refreshed.token_type || 'Bearer',
    scope: refreshed.scope || tokens.scope,
    expiry_date: Date.now() + (refreshed.expires_in * 1000),
  };

  saveTokenFile(tokenPath, updated);
  return updated;
}

async function resolveAccessToken(tokenPath: string): Promise<{ accessToken: string; authuser: string; tokens: GoogleTokenFile }> {
  let tokens = loadTokenFile(tokenPath);
  const expiresAt = tokens.expiry_date || 0;
  const isExpired = !tokens.access_token || Date.now() >= (expiresAt - 60_000);
  if (isExpired) {
    tokens = await refreshAccessToken(tokenPath, tokens);
  }

  const accessToken = process.env.GOOGLE_ACCESS_TOKEN || tokens.access_token;
  if (!accessToken) {
    throw new Error('No Google access token available.');
  }

  return {
    accessToken,
    authuser: process.env.GMAIL_AUTHUSER || process.env.GOOGLE_ACCOUNT_EMAIL || '',
    tokens,
  };
}

async function gmailRequest<T>(path: string, accessToken: string): Promise<T> {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Gmail API request failed (${response.status}): ${await response.text()}`);
  }

  return await response.json() as T;
}

function buildHeaderMap(payload?: GmailMessagePart): Record<string, string> {
  const map: Record<string, string> = {};
  for (const header of payload?.headers ?? []) {
    map[header.name.toLowerCase()] = header.value;
  }
  return map;
}

function collectBodies(part: GmailMessagePart | undefined, out: { html: string[]; text: string[] }) {
  if (!part) return;
  const mimeType = (part.mimeType || '').toLowerCase();
  const data = part.body?.data ? decodeBase64Url(part.body.data) : '';

  if (mimeType === 'text/html' && data) {
    out.html.push(data);
  } else if (mimeType === 'text/plain' && data) {
    out.text.push(data);
  }

  for (const child of part.parts ?? []) {
    collectBodies(child, out);
  }
}

function parseFromHeader(fromHeader: string): { name: string; email: string } {
  const match = fromHeader.match(/^(.*?)(?:\s*<([^>]+)>)?$/);
  const rawName = match?.[1]?.trim().replace(/^"|"$/g, '') || '';
  const email = match?.[2]?.trim() || (fromHeader.includes('@') ? fromHeader.trim() : '');
  const fallbackName = email ? email.split('@')[0] : fromHeader.trim();
  return {
    name: rawName || fallbackName,
    email,
  };
}

function parseListId(value: string | undefined): string {
  if (!value) return '';
  const beforeBracket = value.split('<')[0]?.trim();
  return beforeBracket || value.replace(/[<>]/g, '').trim();
}

function inferNewsletterName(subject: string, fromName: string, listId: string): string {
  if (listId) return listId;
  if (fromName && !/@/.test(fromName)) return fromName;
  const prefix = subject.split(/[:|•-]/)[0]?.trim();
  return prefix || fromName || 'Newsletter';
}

export function buildNewsletterQuery(label: string, backfill: boolean, days?: number): string {
  const needsQuotes = /[\s[\]/]/.test(label);
  const quotedLabel = needsQuotes ? `"${label.replace(/"/g, '\\"')}"` : label;
  const base = `label:${quotedLabel}`;
  if (backfill && days && days > 0) {
    return `${base} newer_than:${Math.floor(days)}d`;
  }
  return base;
}

function normalizeLabelName(value: string): string {
  return value.trim().toLowerCase();
}

function resolveLabelAlias(requestedLabel: string, labels: GmailLabel[]): GmailLabel | null {
  const normalizedRequested = normalizeLabelName(requestedLabel);

  for (const label of labels) {
    if (normalizeLabelName(label.name) === normalizedRequested) return label;
  }

  for (const label of labels) {
    const leaf = label.name.split('/').pop() || label.name;
    if (normalizeLabelName(leaf) === normalizedRequested) return label;
  }

  return null;
}

function buildGmailLink(messageId: string, authuser?: string): string {
  const target = authuser || '0';
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(target)}#all/${messageId}`;
}

export async function fetchNewsletterIssues(opts: FetchNewsletterOpts = {}): Promise<NewsletterIssue[]> {
  const tokenPath = opts.tokenPath || process.env.GOOGLE_TOKEN_PATH || defaultTokenPath();
  const { accessToken, authuser } = await resolveAccessToken(tokenPath);
  const requestedLabel = opts.label || 'news';
  let labelId = opts.labelId;
  let label = requestedLabel;
  if (!labelId) {
    const labelResponse = await gmailRequest<{ labels?: GmailLabel[] }>(
      '/labels',
      accessToken,
    );
    const resolved = resolveLabelAlias(requestedLabel, labelResponse.labels || []);
    if (resolved) {
      labelId = resolved.id;
      label = resolved.name;
    }
  }
  const query = labelId
    ? (Boolean(opts.backfill) && opts.days && opts.days > 0 ? `newer_than:${Math.floor(opts.days)}d` : '')
    : buildNewsletterQuery(label, Boolean(opts.backfill), opts.days);
  const issues: NewsletterIssue[] = [];
  let pageToken: string | undefined;
  let remaining = opts.maxMessages ?? Number.POSITIVE_INFINITY;

  do {
    const params = new URLSearchParams({
      maxResults: String(Math.min(100, remaining)),
    });
    if (query) params.set('q', query);
    if (labelId) params.append('labelIds', labelId);
    if (pageToken) params.set('pageToken', pageToken);

    const page = await gmailRequest<{ messages?: GmailMessageRef[]; nextPageToken?: string }>(
      `/messages?${params.toString()}`,
      accessToken,
    );

    for (const messageRef of page.messages ?? []) {
      const message = await gmailRequest<GmailMessage>(
        `/messages/${messageRef.id}?format=full`,
        accessToken,
      );
      const bodies = { html: [] as string[], text: [] as string[] };
      collectBodies(message.payload, bodies);
      const headers = buildHeaderMap(message.payload);
      const from = parseFromHeader(headers.from || '');
      const receivedAt = headers.date
        ? new Date(headers.date).toISOString()
        : new Date(Number.parseInt(message.internalDate || String(Date.now()), 10)).toISOString();
      const newsletterName = inferNewsletterName(
        headers.subject || message.snippet || 'Newsletter Issue',
        from.name,
        parseListId(headers['list-id']),
      );

      issues.push({
        messageId: message.id,
        threadId: message.threadId,
        subject: headers.subject || message.snippet || 'Untitled Newsletter',
        fromName: from.name,
        fromEmail: from.email,
        newsletterName,
        receivedAt,
        gmailLink: buildGmailLink(message.id, opts.authuser || authuser),
        label,
        htmlBody: bodies.html.join('\n\n'),
        textBody: bodies.text.join('\n\n'),
        snippet: message.snippet,
      });

      remaining -= 1;
      if (remaining <= 0) break;
    }

    pageToken = remaining > 0 ? page.nextPageToken : undefined;
  } while (pageToken);

  return issues.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}
