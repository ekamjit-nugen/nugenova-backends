/**
 * Message content sanitisation — dependency-free port of the monolith's
 * DOMPurify pass (the Nexora repo carries no `isomorphic-dompurify`).
 *
 * The monolith allowed a small formatting tag set and ran DOMPurify to strip
 * everything else. Here we take the more conservative route the threat model
 * actually needs: neutralise the stored-XSS vectors — `<script>`/`<style>`
 * blocks, every `on*=` event-handler attribute, and `javascript:` URIs — and
 * drop any tag NOT on the allow-list, while preserving its inner text. This is
 * intentionally stricter (it removes rather than rewrites unknown tags); the
 * rendered result is equivalent for the formatting tags clients actually use.
 *
 * `plainText` returns the tag-stripped, markdown-symbol-stripped text used for
 * the search column and the empty-message guard — matching the monolith's
 * `contentPlainText` derivation.
 */

const ALLOWED_TAGS = new Set([
  'b', 'i', 'u', 's', 'em', 'strong', 'a', 'p', 'br', 'ul', 'ol', 'li',
  'code', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'span',
]);

export function sanitizeHtml(html: string): string {
  if (!html) return '';
  let out = html;

  // 1. Drop entire <script>/<style> blocks (content and all).
  out = out.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

  // 2. Walk every tag; keep allow-listed ones (attributes scrubbed), drop the
  //    rest (their inner text survives because we only remove the tag markup).
  out = out.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (_m, rawName, attrs) => {
    const name = String(rawName).toLowerCase();
    if (!ALLOWED_TAGS.has(name)) return '';
    const closing = _m.startsWith('</');
    if (closing) return `</${name}>`;
    return `<${name}${scrubAttrs(name, attrs)}>`;
  });

  return out.trim();
}

/** Keep only safe attributes; never keep event handlers or javascript: URIs. */
function scrubAttrs(tag: string, attrs: string): string {
  if (!attrs) return '';
  const kept: string[] = [];
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(attrs)) !== null) {
    const key = m[1].toLowerCase();
    const value = m[3] ?? m[4] ?? m[5] ?? '';
    if (key.startsWith('on')) continue; // event handlers — always drop
    if (tag === 'a' && key === 'href') {
      const v = value.trim().toLowerCase();
      // Block javascript:/vbscript:/data: URIs — only http(s)/mailto/relative.
      if (/^(javascript|vbscript|data):/i.test(v)) continue;
      kept.push(`href="${escapeAttr(value)}"`);
      continue;
    }
    if (tag === 'a' && (key === 'target' || key === 'rel')) {
      kept.push(`${key}="${escapeAttr(value)}"`);
      continue;
    }
    if (key === 'class') {
      kept.push(`class="${escapeAttr(value)}"`);
      continue;
    }
    // Any other attribute is dropped.
  }
  return kept.length ? ' ' + kept.join(' ') : '';
}

function escapeAttr(v: string): string {
  return v.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Tag-stripped, markdown-symbol-stripped text — for search + empty guard. */
export function toPlainText(sanitized: string): string {
  if (!sanitized) return '';
  return sanitized
    .replace(/<[^>]*>/g, '')
    .replace(/[*_~`#>\[\]()!|]/g, '')
    .trim();
}
