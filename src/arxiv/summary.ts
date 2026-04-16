import OpenAI from 'openai';
import type { ArxivPaper } from './api.ts';

export interface PaperSummary {
  contributionSummary: string;
  keyFindings: string[];
  relevanceSummary: string;
  summarySource: 'llm' | 'deterministic';
}

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) client = new OpenAI();
  return client;
}

export async function summarizePaper(
  paper: ArxivPaper,
  text: string,
  opts: { disabled?: boolean; model?: string } = {},
): Promise<PaperSummary> {
  if (opts.disabled || !process.env.OPENAI_API_KEY) {
    return summarizeDeterministically(paper, text);
  }

  try {
    const completion = await getClient().chat.completions.create({
      model: opts.model ?? 'gpt-4o-mini',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You summarize research papers for a knowledge base. Respond with JSON only: {"contribution_summary":"...","key_findings":["..."],"relevance_summary":"..."}',
        },
        {
          role: 'user',
          content: [
            `Title: ${paper.title}`,
            `Authors: ${paper.authors.join(', ')}`,
            `Categories: ${paper.categories.join(', ')}`,
            `Abstract: ${paper.abstract}`,
            '',
            'Paper text excerpt:',
            text.slice(0, 12000),
          ].join('\n'),
        },
      ],
    });

    const content = completion.choices[0]?.message?.content ?? '';
    const parsed = JSON.parse(content) as {
      contribution_summary?: unknown;
      key_findings?: unknown;
      relevance_summary?: unknown;
    };
    const keyFindings = Array.isArray(parsed.key_findings)
      ? parsed.key_findings.map(String).map((line) => line.trim()).filter(Boolean).slice(0, 5)
      : [];

    if (!String(parsed.contribution_summary ?? '').trim() || keyFindings.length === 0) {
      throw new Error('Incomplete summary payload.');
    }

    return {
      contributionSummary: String(parsed.contribution_summary).trim(),
      keyFindings,
      relevanceSummary: String(parsed.relevance_summary ?? '').trim() || fallbackRelevance(paper),
      summarySource: 'llm',
    };
  } catch {
    return summarizeDeterministically(paper, text);
  }
}

export function summarizeDeterministically(paper: ArxivPaper, text: string): PaperSummary {
  const sentences = splitSentences([paper.abstract, text.slice(0, 4000)].join(' '));
  const keyFindings = dedupeStrings([
    sentences[1],
    sentences[2],
    categoryFinding(paper),
  ]).filter(Boolean).slice(0, 4);

  return {
    contributionSummary:
      sentences[0] ??
      `This paper contributes research in ${paper.primaryCategory ?? paper.categories[0] ?? 'its stated domain'}.`,
    keyFindings:
      keyFindings.length > 0
        ? keyFindings
        : [`The abstract emphasizes ${paper.primaryCategory ?? 'the paper domain'} as the main area of contribution.`],
    relevanceSummary: fallbackRelevance(paper),
    summarySource: 'deterministic',
  };
}

function categoryFinding(paper: ArxivPaper): string {
  if (paper.categories.length === 0) return '';
  if (paper.categories.length === 1) return `ArXiv categorizes this work under ${paper.categories[0]}.`;
  return `ArXiv categorizes this work under ${paper.categories.slice(0, 3).join(', ')}.`;
}

function fallbackRelevance(paper: ArxivPaper): string {
  const primary = paper.primaryCategory ?? paper.categories[0];
  if (!primary) return 'Potentially relevant as recent research to cross-reference against existing brain concepts.';
  return `Potentially relevant to ${primary} workstreams and adjacent concepts already tracked in the brain.`;
}

function splitSentences(value: string): string[] {
  return value
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 30);
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}
