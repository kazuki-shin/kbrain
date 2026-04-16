import { describe, expect, test } from 'bun:test';
import {
  htmlToNewsletterMarkdown,
  extractNewsletterTopics,
  extractNewsletterEntities,
  buildNewsletterPage,
} from '../src/newsletters/compiler.ts';

describe('newsletter compiler', () => {
  test('strips email chrome while preserving article links and content', () => {
    const markdown = htmlToNewsletterMarkdown(`
      <html>
        <body>
          <p><a href="https://example.com/web">View in browser</a></p>
          <h1>AI Agents Weekly</h1>
          <p>Anthropic shipped <a href="https://example.com/claude">Claude Code</a> for teams.</p>
          <p>Sarah Chen says the rollout is moving fast.</p>
          <p><a href="https://example.com/unsub">Unsubscribe</a></p>
        </body>
      </html>
    `);

    expect(markdown).toContain('# AI Agents Weekly');
    expect(markdown).toContain('[Claude Code](https://example.com/claude)');
    expect(markdown).toContain('Sarah Chen says the rollout is moving fast.');
    expect(markdown).not.toContain('View in browser');
    expect(markdown).not.toContain('Unsubscribe');
  });

  test('extracts deterministic topics and entities', () => {
    const topics = extractNewsletterTopics(
      'AI Agents Weekly: Model Context Protocol',
      '## Model Context Protocol\n\nAnthropic and OpenAI are both pushing Claude Code and GPT-5 tooling.',
    );
    const entities = extractNewsletterEntities(
      'Anthropic hired Sarah Chen to lead Claude Code integrations with GPT-5 and OpenAI.',
    );

    expect(topics).toContain('AI Agents Weekly');
    expect(topics).toContain('Model Context Protocol');
    expect(entities.people).toContain('Sarah Chen');
    expect(entities.companies).toContain('Anthropic');
    expect(entities.companies).toContain('OpenAI');
    expect(entities.products).toContain('Claude Code');
    expect(entities.products).toContain('GPT-5');
  });

  test('builds a newsletter source page with required frontmatter', () => {
    const page = buildNewsletterPage({
      messageId: '191abc123',
      threadId: 'thread-1',
      subject: 'AI Agents Weekly: The Browser Use Stack',
      fromName: 'AI Agents Weekly',
      fromEmail: 'hello@example.com',
      newsletterName: 'AI Agents Weekly',
      receivedAt: '2026-04-15T16:30:00.000Z',
      gmailLink: 'https://mail.google.com/mail/u/?authuser=test#all/191abc123',
      label: 'news',
      htmlBody: '<h1>The Browser Use Stack</h1><p>OpenAI shipped GPT-5. Sarah Chen reviewed it.</p>',
      textBody: '',
    });

    expect(page.path).toMatch(/^sources\/newsletters\/ai-agents-weekly\//);
    expect(page.slug).toContain('sources/newsletters/ai-agents-weekly/');
    expect(page.frontmatter.newsletter_name).toBe('AI Agents Weekly');
    expect(page.frontmatter.gmail_message_id).toBe('191abc123');
    expect(page.frontmatter.date).toBe('2026-04-15');
    expect(page.frontmatter.topics).toBeArray();
    expect(page.content).toContain('## Issue');
    expect(page.content).toContain('## Content');
    expect(page.content).toContain('[Open in Gmail](https://mail.google.com/mail/u/?authuser=test#all/191abc123)');
  });
});
