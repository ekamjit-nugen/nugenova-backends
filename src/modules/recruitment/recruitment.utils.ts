/**
 * Pure normalisers for the Recruitment module — shared by the Excel importer,
 * the CV parser and manual entry so every path stores the same canonical shape.
 * No I/O here; everything is unit-tested in recruitment.utils.spec.ts.
 */
import { CANDIDATE_SOURCES, CandidateSource, NoticeStatus } from './recruitment.constants';

/** Placeholder cells the team's sheets use for "unknown". */
const BLANK_RE = /^\s*(—|–|-{1,3}|n\/?a|na|nil|none|null|not (mentioned|available|found)|\?)\s*$/i;

/** Trim a cell; placeholders ("—", "N/A", "-") and empty strings become null. */
export function cleanCell(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (!s || BLANK_RE.test(s)) return null;
  return s;
}

/** Lower-cased, trimmed email, or null when it doesn't look like one. */
export function normalizeEmail(v: unknown): string | null {
  const s = cleanCell(v);
  if (!s) return null;
  const m = s.toLowerCase().match(/[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/);
  return m ? m[0] : null;
}

/**
 * Phone → E.164-ish. Defaults to India (+91) for bare 10-digit numbers, which is
 * the team's market. Returns null when fewer than 8 digits remain.
 */
export function normalizePhone(v: unknown, defaultCountry = '91'): string | null {
  const s = cleanCell(v);
  if (!s) return null;
  const hasPlus = s.trim().startsWith('+');
  let digits = s.replace(/\D/g, '');
  if (digits.length < 8) return null;
  if (!hasPlus) {
    if (digits.length === 11 && digits.startsWith('0')) digits = defaultCountry + digits.slice(1);
    else if (digits.length === 10) digits = defaultCountry + digits;
    else if (digits.length === 12 && digits.startsWith('00')) digits = digits.slice(2);
  }
  if (digits.length > 15) digits = digits.slice(0, 15);
  return `+${digits}`;
}

/**
 * Free-text experience → whole months.
 * "5+ years" → 60, "3 years 6 months" → 42, "1.5 yrs" → 18, "8 months" → 8,
 * "24 Years" → 288, "fresher" → 0. Unparseable → null.
 */
export function parseExperienceMonths(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.round(v * 12));
  const s = cleanCell(v)?.toLowerCase();
  if (!s) return null;
  if (/\bfresher\b|\bentry[- ]level\b/.test(s)) return 0;
  const years = s.match(/(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?|y\b)/);
  const months = s.match(/(\d+(?:\.\d+)?)\s*\+?\s*(?:months?|mos?|m\b)/);
  if (years || months) {
    const total = (years ? parseFloat(years[1]) * 12 : 0) + (months ? parseFloat(months[1]) : 0);
    return Math.round(total);
  }
  const bare = s.match(/^(\d+(?:\.\d+)?)\s*\+?$/);
  if (bare) return Math.round(parseFloat(bare[1]) * 12);
  return null;
}

/**
 * Notice-period text → { days, status }.
 * "Immediate Joiner" → 0/immediate, "30 days" → 30/fixed, "2 months" → 60/fixed,
 * "serving notice, LWD 15 Oct" → null/serving, "negotiable" → null/negotiable.
 */
export function parseNotice(v: unknown): { days: number | null; status: NoticeStatus } {
  if (typeof v === 'number' && Number.isFinite(v)) return { days: Math.max(0, Math.round(v)), status: v === 0 ? 'immediate' : 'fixed' };
  const s = cleanCell(v)?.toLowerCase();
  if (!s) return { days: null, status: 'unknown' };
  if (/immediate|\bimm\b|available now|already relieved|\brelieved\b/.test(s)) return { days: 0, status: 'immediate' };
  const status: NoticeStatus = /serving/.test(s) ? 'serving' : /negotiable|buy ?out/.test(s) ? 'negotiable' : 'fixed';
  const d = s.match(/(\d+)\s*(?:days?|d\b)/);
  const w = s.match(/(\d+)\s*(?:weeks?|wks?)/);
  const m = s.match(/(\d+(?:\.\d+)?)\s*(?:months?|mos?)/);
  const days = d ? parseInt(d[1], 10) : w ? parseInt(w[1], 10) * 7 : m ? Math.round(parseFloat(m[1]) * 30) : null;
  if (days == null && status === 'fixed') return { days: null, status: 'unknown' };
  return { days, status };
}

/** Map a free-text source label onto the enum (unknown → 'other'). */
export function normalizeSource(v: unknown): CandidateSource | null {
  const s = cleanCell(v)?.toLowerCase().replace(/[\s-]+/g, '_');
  if (!s) return null;
  if ((CANDIDATE_SOURCES as readonly string[]).includes(s)) return s as CandidateSource;
  if (s.includes('cutshort')) return 'cutshort';
  if (s.includes('linkedin')) return 'linkedin';
  if (s.includes('naukri')) return 'naukri';
  if (s.includes('indeed')) return 'indeed';
  if (s.includes('refer')) return 'referral';
  if (s.includes('career') || s.includes('website')) return 'careers_page';
  if (s.includes('agency') || s.includes('consultant') || s.includes('vendor')) return 'agency';
  return 'other';
}

/** Title-case a person's name when it arrives ALL CAPS or all lower. */
export function tidyName(v: unknown): string | null {
  const s = cleanCell(v);
  if (!s) return null;
  if (s === s.toUpperCase() || s === s.toLowerCase()) {
    return s.toLowerCase().replace(/(^|[\s.'-])(\p{L})/gu, (_m, p, c) => p + c.toUpperCase());
  }
  return s;
}

/**
 * A "name" cell that is really a sheet note, not a person: footers such as
 * "Total candidates in this sheet: 10", banners such as
 * "Generated: Summary.xlsx | Auto-extracted …", or totals rows.
 */
export function looksLikeSheetNote(v: unknown): boolean {
  const s = cleanCell(v);
  if (!s) return false;
  if (s.length > 80) return true;
  if (/\.(xlsx?|xlsm|csv)\b/i.test(s)) return true;
  if (/\s\|\s/.test(s)) return true;
  if (/^(total|grand total|sub-?total|generated|prepared|exported|summary|note|notes|count|source|report|sheet|legend)\b/i.test(s)) return true;
  if (/:\s*\d+\s*$/.test(s)) return true;
  if (/^[\d\s.,:/-]+$/.test(s)) return true;
  return false;
}

/** Shorten at a word boundary rather than mid-word. */
const trimTo = (s: string, max: number): string => {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trim();
};

/**
 * De-duplicated, trimmed list of short strings (skills/tags).
 *
 * An entry over the cap is split on its slashes before being shortened: a CV line
 * like "Snowflake Snowpipe/Streams/Tasks/Time Travel" is several skills, while
 * "CI/CD" is one — the length is what tells them apart. Mirrors `splitTags` in
 * the frontend, so an imported row and a typed one end up the same shape.
 */
export function cleanList(v: unknown, maxItems = 60, maxLen = 60): string[] {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;|\n•]/) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const s = cleanCell(item);
    if (!s) continue;
    const parts: string[] = s.length <= maxLen ? [s] : s.split('/').map((x) => cleanCell(x) ?? '').filter(Boolean);
    for (const part of parts) {
      const value = trimTo(part, maxLen);
      const key = value.toLowerCase();
      if (!value || seen.has(key)) continue;
      seen.add(key);
      out.push(value);
      if (out.length >= maxItems) return out;
    }
  }
  return out;
}

/** Is this a Cutshort export file name? (`Cutshort-<Name>-<Role>-xxxx.pdf`) */
export function isCutshortFileName(name: string | null | undefined): boolean {
  return /^cutshort[-_ ]/i.test((name || '').trim());
}

/**
 * Parse the team's legacy "Remarks" cell, e.g.
 * `[Data Engineer] Source: Data Engineer Profiles; Notice period not mentioned; Duplicate candidate`.
 * Returns the role tag, the source label and any remaining human notes — the
 * boilerplate "X not found / not mentioned" parser notes are dropped.
 */
export function parseLegacyRemarks(v: unknown): { role: string | null; sourceLabel: string | null; notes: string | null } {
  let s = cleanCell(v) ?? '';
  let role: string | null = null;
  const roleMatch = s.match(/^\[([^\]]+)\]\s*/);
  if (roleMatch) { role = roleMatch[1].trim(); s = s.slice(roleMatch[0].length); }
  let sourceLabel: string | null = null;
  const notes: string[] = [];
  for (const partRaw of s.split(';')) {
    const part = partRaw.trim().replace(/\.{3}$/, '').trim();
    if (!part) continue;
    const src = part.match(/^source\s*:\s*(.+)$/i);
    if (src) { sourceLabel = src[1].trim(); continue; }
    if (/\b(not mentioned|not found)\b/i.test(part)) continue;
    notes.push(part);
  }
  return { role, sourceLabel, notes: notes.length ? notes.join('; ') : null };
}

/** Strip trailing employment date ranges from a company cell ("Acme Jul 2022 – Present"). */
export function tidyCompany(v: unknown): string | null {
  const s = cleanCell(v);
  if (!s) return null;
  const cleaned = s
    .replace(/^currently (at|with)\s+/i, '')
    .replace(/\s*\(?\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*'?\d{2,4}\s*[–—-]\s*(present|current|now|till date|(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*'?\d{2,4})\)?\s*$/i, '')
    .trim();
  return cleaned || s;
}

export interface EducationEntry { degree: string | null; institution: string | null; year: string | null; score: string | null }
export interface WorkEntry { company: string | null; designation: string | null; from: string | null; to: string | null; current: boolean; summary: string | null }

/**
 * Build a safe prefix tsquery from free text: `"power bi dev"` → `power:* & bi:* & dev:*`.
 * Returns null when nothing searchable remains.
 */
export function toPrefixTsQuery(q: string | null | undefined): string | null {
  const tokens = (q || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
    .slice(0, 8);
  if (!tokens.length) return null;
  return tokens.map((t) => `${t}:*`).join(' & ');
}

/** Human "5y 3m" from months (used in exports + activity text). */
export function formatExperience(months: number | null | undefined): string {
  if (months == null) return '';
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (!y) return `${m}m`;
  return m ? `${y}y ${m}m` : `${y}y`;
}
