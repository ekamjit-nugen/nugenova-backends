import { sanitizeHtml, toPlainText } from './sanitize.util';

/**
 * The sanitiser is the dependency-free stand-in for the monolith's DOMPurify
 * pass. These specs pin the stored-XSS guarantees: script/style blocks, event
 * handlers, and dangerous URI schemes never survive, while the allow-listed
 * formatting tags do.
 */
describe('sanitizeHtml', () => {
  it('drops <script> blocks entirely (content and all)', () => {
    const out = sanitizeHtml('hi<script>alert(1)</script> there');
    expect(out).not.toContain('script');
    expect(out).not.toContain('alert');
    expect(out).toContain('hi');
    expect(out).toContain('there');
  });

  it('strips on* event-handler attributes', () => {
    const out = sanitizeHtml('<span onclick="steal()">x</span>');
    expect(out).toContain('<span>');
    expect(out).not.toContain('onclick');
  });

  it('neutralises javascript: hrefs but keeps http links', () => {
    expect(sanitizeHtml('<a href="javascript:evil()">x</a>')).not.toContain('javascript:');
    const safe = sanitizeHtml('<a href="https://x.io" target="_blank">x</a>');
    expect(safe).toContain('href="https://x.io"');
    expect(safe).toContain('target="_blank"');
  });

  it('keeps allow-listed formatting tags, drops unknown tags but keeps their text', () => {
    const out = sanitizeHtml('<strong>bold</strong> <marquee>slide</marquee>');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).not.toContain('marquee');
    expect(out).toContain('slide');
  });

  it('returns empty string for falsy input', () => {
    expect(sanitizeHtml('')).toBe('');
    expect(sanitizeHtml(undefined as any)).toBe('');
  });
});

describe('toPlainText', () => {
  it('strips tags and markdown symbols for the search index', () => {
    expect(toPlainText('<p>Hello **world**</p>')).toBe('Hello world');
  });

  it('is empty for tag-only content (feeds the empty-message guard)', () => {
    expect(toPlainText('<p></p>')).toBe('');
  });
});
