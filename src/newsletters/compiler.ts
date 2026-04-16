import path from 'node:path';
import { serializeMarkdown } from '../core/markdown.ts';
import { slugifySegment } from '../core/sync.ts';
import { extractEntities } from '../core/enrichment-service.ts';

export interface NewsletterIssue {
  messageId: string;
  threadId: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  newsletterName: string;
  receivedAt: string;
  gmailLink: string;
  label: string;
  htmlBody: string;
  textBody: string;
  snippet?: string;
}

export interface NewsletterEntities {
  people: string[];
  companies: string[];
  products: string[];
}

export interface CompiledNewsletterPage {
  path: string;
  slug: string;
  content: string;
  frontmatter: Record<string, unknown>;
  topics: string[];
  entities: NewsletterEntities;
}

const NEWSLETTER_CHROME_PATTERNS = [
  /view (this )?(email|message|newsletter) in (your )?browser/i,
  /view in browser/i,
  /read (online|in browser)/i,
  /unsubscribe/i,
  /manage (your )?(preferences|subscription)/i,
  /update (your )?(email )?preferences/i,
  /why did (you|get) this email/i,
  /you are receiving this email/i,
  /sent to .+@.+ because/i,
  /privacy policy/i,
  /terms of service/i,
  /forward(ed)? to a friend/i,
  /share this newsletter/i,
  /was this forwarded to you/i,
  /sponsor(ed)? by/i,
  /advertisement/i,
  /view web version/i,
  /open in browser/i,
];

const TOPIC_STOPWORDS = new Set([
  'about', 'after', 'again', 'agent', 'agents', 'also', 'another', 'around', 'because',
  'before', 'brain', 'build', 'built', 'building', 'company', 'daily', 'email', 'from',
  'into', 'issue', 'just', 'more', 'most', 'news', 'newsletter', 'people', 'product',
  'products', 'research', 'source', 'story', 'team', 'than', 'that', 'their', 'them',
  'these', 'they', 'this', 'today', 'using', 'what', 'when', 'where', 'which', 'with',
  'your',
]);

const PRODUCT_HINTS = /\b(API|SDK|Studio|Cloud|Code|Copilot|Assistant|Agents?|GPT(?:-\d+(?:\.\d+)?)?|Claude|Gemini|Cursor|Notion|Linear|Slack|Figma|Supabase|Postgres|OpenAI|Anthropic|MCP|Vercel|Model|DB|OS|Platform)\b/;
const COMMON_FALSE_POSITIVES = new Set([
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December', 'The Information', 'Read Online', 'Open In Browser',
]);

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripNewsletterChrome(markdown: string): string {
  const blocks = markdown
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .filter((block) => {
      const lineCount = block.split('\n').length;
      const wordCount = block.split(/\s+/).filter(Boolean).length;
      const hits = NEWSLETTER_CHROME_PATTERNS.filter((pattern) => pattern.test(block)).length;

      if (hits === 0) return true;
      if (hits >= 2) return false;
      if (wordCount <= 30) return false;
      if (lineCount <= 2) return false;
      return !/unsubscribe|preferences|privacy policy/i.test(block);
    });

  return normalizeWhitespace(blocks.join('\n\n'));
}

export function htmlToNewsletterMarkdown(html: string): string {
  if (!html.trim()) return '';

  let text = html;
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<(script|style|head|svg|noscript)[\s\S]*?<\/\1>/gi, '');

  // Preserve links before stripping remaining HTML.
  text = text.replace(/<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_, __, href, inner) => {
    const label = stripTags(inner) || href;
    return `[${label}](${decodeHtmlEntities(href)})`;
  });

  text = text.replace(/<img\b[^>]*alt=(["'])(.*?)\1[^>]*>/gi, (_, __, alt) => stripTags(alt));
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|section|article|table|tr|blockquote)>/gi, '\n\n');
  text = text.replace(/<(p|div|section|article|table|tr|blockquote)\b[^>]*>/gi, '\n\n');
  text = text.replace(/<(ul|ol)\b[^>]*>/gi, '\n');
  text = text.replace(/<\/(ul|ol)>/gi, '\n');
  text = text.replace(/<li\b[^>]*>/gi, '\n- ');
  text = text.replace(/<\/li>/gi, '');

  for (let level = 6; level >= 1; level--) {
    const pattern = new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)<\\/h${level}>`, 'gi');
    text = text.replace(pattern, (_, inner) => {
      const heading = stripTags(inner);
      return heading ? `\n\n${'#'.repeat(level)} ${heading}\n\n` : '\n\n';
    });
  }

  text = decodeHtmlEntities(text);
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n[ \t]+/g, '\n');
  text = text.replace(/[ \t]{2,}/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');

  return stripNewsletterChrome(normalizeWhitespace(text));
}

function normalizeTopic(value: string): string {
  return value
    .replace(/\[[^\]]+\]\([^)]+\)/g, '$1')
    .replace(/[^\w\s/+.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

export function extractNewsletterTopics(subject: string, markdown: string, limit = 5): string[] {
  const candidates: string[] = [];
  const addCandidate = (value: string) => {
    const cleaned = normalizeTopic(value);
    if (!cleaned) return;
    if (cleaned.length < 4) return;
    const normalized = cleaned.toLowerCase();
    if (TOPIC_STOPWORDS.has(normalized)) return;
    if (candidates.some((existing) => existing.toLowerCase() === normalized)) return;
    candidates.push(cleaned);
  };

  subject.split(/[:|•-]/).forEach(addCandidate);
  markdown
    .split('\n')
    .filter((line) => /^#{1,3}\s+/.test(line))
    .map((line) => line.replace(/^#{1,3}\s+/, ''))
    .forEach(addCandidate);

  const tokens = `${subject}\n${markdown}`
    .replace(/\[[^\]]+\]\([^)]+\)/g, '$1')
    .toLowerCase()
    .match(/\b[a-z][a-z0-9-]{3,}\b/g) ?? [];
  const counts = new Map<string, number>();
  for (const token of tokens) {
    if (TOPIC_STOPWORDS.has(token)) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }

  [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit * 2)
    .forEach(([token]) => addCandidate(titleCase(token)));

  return candidates.slice(0, limit);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function extractProductMentions(text: string): string[] {
  const products = new Set<string>();
  const multiWordPattern = /\b([A-Z][A-Za-z0-9.+-]*(?:\s+[A-Z0-9][A-Za-z0-9.+-]*){0,2})\b/g;

  for (const match of text.matchAll(multiWordPattern)) {
    const candidate = match[1].trim();
    if (candidate.length < 3) continue;
    if (COMMON_FALSE_POSITIVES.has(candidate)) continue;
    if (!PRODUCT_HINTS.test(candidate)) continue;
    products.add(candidate);
  }

  return uniqueSorted(products);
}

function extractSingleWordCompanies(text: string): string[] {
  const companies = new Set<string>();
  const singleWordPattern = /\b([A-Z][A-Za-z]+(?:AI|Labs|Cloud|DB)|OpenAI|Anthropic|Google|Microsoft|Meta|Amazon|Stripe|Notion|Linear|Figma|Cursor|Supabase|Vercel)\b/g;

  for (const match of text.matchAll(singleWordPattern)) {
    const candidate = match[1];
    if (COMMON_FALSE_POSITIVES.has(candidate)) continue;
    companies.add(candidate);
  }

  return uniqueSorted(companies);
}

export function extractNewsletterEntities(text: string): NewsletterEntities {
  const products = extractProductMentions(text);
  const entities = extractEntities(text);
  const people = uniqueSorted(
    entities
      .filter((entity) => entity.type === 'person')
      .map((entity) => entity.name)
      .filter((name) => !COMMON_FALSE_POSITIVES.has(name))
      .filter((name) => !PRODUCT_HINTS.test(name)),
  );
  const companies = uniqueSorted([
    ...entities
      .filter((entity) => entity.type === 'company')
      .map((entity) => entity.name)
      .filter((name) => !COMMON_FALSE_POSITIVES.has(name)),
    ...extractSingleWordCompanies(text),
  ]);
  const filteredProducts = products.filter(
    (name) => !people.includes(name) && !companies.includes(name),
  );

  return { people, companies, products: filteredProducts };
}

function excerpt(text: string, maxLength = 280): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  const slice = compact.slice(0, maxLength);
  const boundary = slice.lastIndexOf(' ');
  return `${(boundary > 0 ? slice.slice(0, boundary) : slice).trim()}...`;
}

function buildIssuePath(issue: NewsletterIssue): string {
  const newsletterSlug = slugifySegment(issue.newsletterName || issue.fromName || 'newsletter') || 'newsletter';
  const date = issue.receivedAt.slice(0, 10);
  const subjectSlug = slugifySegment(issue.subject).slice(0, 72) || 'issue';
  const idSuffix = slugifySegment(issue.messageId).slice(-12) || issue.messageId.slice(-12);
  return path.join('sources', 'newsletters', newsletterSlug, `${date}-${subjectSlug}-${idSuffix}.md`);
}

export function buildNewsletterPage(issue: NewsletterIssue): CompiledNewsletterPage {
  const baseMarkdown = htmlToNewsletterMarkdown(issue.htmlBody);
  const fallbackText = normalizeWhitespace(issue.textBody || issue.snippet || '');
  const newsletterMarkdown =
    baseMarkdown && baseMarkdown.split(/\s+/).filter(Boolean).length >= 40
      ? baseMarkdown
      : fallbackText || baseMarkdown;
  const topics = extractNewsletterTopics(issue.subject, newsletterMarkdown);
  const entities = extractNewsletterEntities(`${issue.subject}\n${newsletterMarkdown}`);
  const issuePath = buildIssuePath(issue);
  const slug = issuePath.replace(/\.md$/, '').replace(/\\/g, '/');

  const frontmatter = {
    source: issue.fromEmail || issue.newsletterName,
    date: issue.receivedAt.slice(0, 10),
    newsletter_name: issue.newsletterName,
    topics,
    people: entities.people,
    companies: entities.companies,
    products: entities.products,
    gmail_message_id: issue.messageId,
    gmail_thread_id: issue.threadId,
    gmail_label: issue.label,
    gmail_link: issue.gmailLink,
    sender_email: issue.fromEmail,
    sender_name: issue.fromName,
    received_at: issue.receivedAt,
    tags: ['email-to-brain', 'newsletter', 'gmail'],
  };

  const compiledTruth = [
    `# ${issue.subject}`,
    '',
    `${issue.newsletterName} issue ingested from Gmail. [Source: Gmail newsletter, ${issue.receivedAt.slice(0, 10)}]`,
    '',
    '## Issue',
    `- Newsletter: ${issue.newsletterName}. [Source: Gmail newsletter, ${issue.receivedAt.slice(0, 10)}]`,
    `- From: ${issue.fromName}${issue.fromEmail ? ` <${issue.fromEmail}>` : ''}. [Source: Gmail newsletter, ${issue.receivedAt.slice(0, 10)}]`,
    `- Received: ${issue.receivedAt}. [Source: Gmail newsletter, ${issue.receivedAt.slice(0, 10)}]`,
    `- Gmail: [Open in Gmail](${issue.gmailLink})`,
    ...(topics.length > 0
      ? [`- Topics: ${topics.join(', ')}. [Source: Gmail newsletter, ${issue.receivedAt.slice(0, 10)}]`]
      : []),
    '',
    '## Entities',
    ...(entities.people.length > 0
      ? [`- People: ${entities.people.join(', ')}. [Source: Gmail newsletter, ${issue.receivedAt.slice(0, 10)}]`]
      : []),
    ...(entities.companies.length > 0
      ? [`- Companies: ${entities.companies.join(', ')}. [Source: Gmail newsletter, ${issue.receivedAt.slice(0, 10)}]`]
      : []),
    ...(entities.products.length > 0
      ? [`- Products: ${entities.products.join(', ')}. [Source: Gmail newsletter, ${issue.receivedAt.slice(0, 10)}]`]
      : []),
    ...(
      entities.people.length === 0 &&
      entities.companies.length === 0 &&
      entities.products.length === 0
        ? [`- No named entities were extracted deterministically. [Source: Gmail newsletter, ${issue.receivedAt.slice(0, 10)}]`]
        : []
    ),
    '',
    '## Summary',
    `${excerpt(newsletterMarkdown)} [Source: Gmail newsletter, ${issue.receivedAt.slice(0, 10)}]`,
    '',
    '## Content',
    '',
    newsletterMarkdown || '_No newsletter body could be extracted._',
  ].join('\n');

  const timeline = [
    '## Timeline',
    '',
    `- **${issue.receivedAt.slice(0, 10)}** | Newsletter issue — ${issue.newsletterName}: "${issue.subject}". [Source: Gmail, ${issue.gmailLink}]`,
  ].join('\n');

  return {
    path: issuePath.replace(/\\/g, '/'),
    slug,
    content: serializeMarkdown(
      frontmatter,
      compiledTruth,
      timeline,
      { type: 'source', title: issue.subject, tags: ['email-to-brain', 'newsletter', 'gmail'] },
    ),
    frontmatter,
    topics,
    entities,
  };
}
