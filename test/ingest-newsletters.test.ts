import { describe, expect, test } from 'bun:test';
import { buildNewsletterQuery } from '../src/newsletters/gmail.ts';
import { matchExistingBrainPages } from '../src/commands/ingest-newsletters.ts';

describe('ingest:newsletters', () => {
  test('builds the label-only query by default', () => {
    expect(buildNewsletterQuery('news', false)).toBe('label:news');
  });

  test('builds backfill query when days are supplied', () => {
    expect(buildNewsletterQuery('news', true, 30)).toBe('label:news newer_than:30d');
  });

  test('matches newsletter entities to existing brain pages by normalized title', () => {
    const matches = matchExistingBrainPages(
      ['Sarah Chen', 'Claude Code', 'OpenAI'],
      [
        { slug: 'people/sarah-chen', title: 'Sarah Chen' },
        { slug: 'concepts/claude-code', title: 'Claude Code' },
        { slug: 'companies/openai', title: 'OpenAI' },
        { slug: 'projects/browser-use', title: 'Browser Use' },
      ],
    );

    expect(matches.map((match) => match.slug)).toEqual([
      'companies/openai',
      'concepts/claude-code',
      'people/sarah-chen',
    ]);
  });
});
