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

/** De-duplicated, trimmed list of short strings (skills/tags). */
export function cleanList(v: unknown, maxItems = 60, maxLen = 60): string[] {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;|\n•]/) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const s = cleanCell(item);
    if (!s || s.length > maxLen) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= maxItems) break;
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

/** The canonical profile fields the CV parser / importer produce. */
export interface ParsedCandidate {
  fullName: string | null;
  email: string | null;
  phone: string | null;
  altPhone: string | null;
  currentLocation: string | null;
  preferredLocations: string[];
  totalExpMonths: number | null;
  currentCompany: string | null;
  currentDesignation: string | null;
  currentCtc: number | null;
  expectedCtc: number | null;
  noticePeriodDays: number | null;
  noticeStatus: NoticeStatus;
  highestQualification: string | null;
  education: EducationEntry[];
  workHistory: WorkEntry[];
  skills: string[];
  linkedinUrl: string | null;
  githubUrl: string | null;
  portfolioUrl: string | null;
  /** Short factual profile summary (maps 1:1 onto `candidates.ai_summary`). */
  aiSummary: string | null;
}

const str = (v: unknown, max = 300): string | null => {
  const s = cleanCell(v);
  return s ? s.slice(0, max) : null;
};

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/[, ]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const url = (v: unknown, host?: RegExp): string | null => {
  const s = cleanCell(v);
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (host && !host.test(u.hostname)) return null;
    return u.toString().slice(0, 500);
  } catch {
    return null;
  }
};

/**
 * Sum work-history durations (months) when the CV doesn't state total experience.
 * Overlapping ranges are merged so parallel roles aren't double counted.
 */
export function experienceFromHistory(history: WorkEntry[], now = new Date()): number | null {
  const toDate = (s: string | null, current: boolean): Date | null => {
    if (current || (s && /present|current|now|till/i.test(s))) return now;
    if (!s) return null;
    const m = s.match(/(\d{4})(?:[-/.](\d{1,2}))?/);
    if (m) return new Date(parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) - 1 : 0, 1);
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const ranges = history
    .map((w) => [toDate(w.from, false), toDate(w.to, w.current)] as const)
    .filter((r): r is readonly [Date, Date] => !!r[0] && !!r[1] && r[1] >= r[0])
    .map(([a, b]) => [a.getTime(), b.getTime()] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  if (!ranges.length) return null;
  let total = 0;
  let [cs, ce] = ranges[0];
  for (const [s, e] of ranges.slice(1)) {
    if (s <= ce) ce = Math.max(ce, e);
    else { total += ce - cs; cs = s; ce = e; }
  }
  total += ce - cs;
  return Math.round(total / (1000 * 60 * 60 * 24 * 30.44));
}

/**
 * Validate + normalise raw LLM JSON into a {@link ParsedCandidate}. Anything
 * malformed is dropped rather than trusted — the recruiter reviews the result.
 */
export function sanitizeParsedCandidate(raw: any): ParsedCandidate {
  const r = raw && typeof raw === 'object' ? raw : {};
  const emails = [r.email, ...(Array.isArray(r.emails) ? r.emails : [])].map(normalizeEmail).filter(Boolean) as string[];
  const phones = [r.phone, ...(Array.isArray(r.phones) ? r.phones : [])].map((p) => normalizePhone(p)).filter(Boolean) as string[];
  const uniqPhones = [...new Set(phones)];

  const education: EducationEntry[] = (Array.isArray(r.education) ? r.education : []).slice(0, 10).map((e: any) => ({
    degree: str(e?.degree, 200), institution: str(e?.institution, 200), year: str(e?.year, 40), score: str(e?.score, 40),
  })).filter((e: EducationEntry) => e.degree || e.institution);

  const workHistory: WorkEntry[] = (Array.isArray(r.workHistory) ? r.workHistory : []).slice(0, 20).map((w: any) => ({
    company: str(w?.company, 200), designation: str(w?.designation, 200), from: str(w?.from, 40), to: str(w?.to, 40),
    current: w?.current === true, summary: str(w?.summary, 1000),
  })).filter((w: WorkEntry) => w.company || w.designation);

  let totalExpMonths = num(r.totalExpMonths);
  if (totalExpMonths == null && r.totalExperience != null) totalExpMonths = parseExperienceMonths(r.totalExperience);
  if (totalExpMonths == null) totalExpMonths = experienceFromHistory(workHistory);
  if (totalExpMonths != null) totalExpMonths = Math.min(Math.max(0, Math.round(totalExpMonths)), 720);

  const notice = r.noticePeriodDays != null ? parseNotice(num(r.noticePeriodDays) ?? r.noticePeriodDays) : parseNotice(r.noticePeriod);
  const current = workHistory.find((w) => w.current) ?? workHistory[0];
  // Annual CTC in rupees. Models sometimes answer in lakhs ("18" for 18 LPA) — values
  // under 1,000 can't be a real annual salary, so treat them as lakhs.
  const ctc = (v: unknown) => {
    const lakh = typeof v === 'string' && /\b(l|lpa|lakhs?|lacs?)\b/i.test(v) ? num(v.replace(/[^\d.]/g, '')) : null;
    const n = lakh != null ? lakh * 100_000 : num(v);
    if (n == null || n < 0 || n >= 1e10) return null;
    return n < 1000 ? Math.round(n * 100_000) : n;
  };

  return {
    fullName: tidyName(str(r.fullName ?? r.name, 200)),
    email: emails[0] ?? null,
    phone: uniqPhones[0] ?? null,
    altPhone: uniqPhones[1] ?? null,
    currentLocation: str(r.currentLocation ?? r.location, 120),
    preferredLocations: cleanList(r.preferredLocations, 10, 80),
    totalExpMonths,
    currentCompany: tidyCompany(str(r.currentCompany, 200)) ?? current?.company ?? null,
    currentDesignation: str(r.currentDesignation, 200) ?? current?.designation ?? null,
    currentCtc: ctc(r.currentCtc),
    expectedCtc: ctc(r.expectedCtc),
    noticePeriodDays: notice.days,
    noticeStatus: notice.status,
    highestQualification: str(r.highestQualification, 200) ?? education[0]?.degree ?? null,
    education,
    workHistory,
    skills: cleanList(r.skills, 60, 60),
    linkedinUrl: url(r.linkedinUrl, /(^|\.)linkedin\.com$/i),
    githubUrl: url(r.githubUrl, /(^|\.)github\.com$/i),
    portfolioUrl: url(r.portfolioUrl),
    aiSummary: str(r.aiSummary ?? r.summary, 1200),
  };
}

/**
 * Cheap regex fallback used when the LLM is unavailable: pulls email, phones and
 * a LinkedIn/GitHub URL straight from the CV text.
 */
/**
 * The candidate's name as CVs usually print it: one of the first lines, 2–4
 * words of letters only ("ANMOL KUMAR SHARMA", "Priya S. Nair"). Skips headings
 * such as "Curriculum Vitae" or "Profile Summary".
 */
export function guessNameFromText(text: string): string | null {
  const lines = (text || '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 6);
  for (const line of lines) {
    if (line.length < 4 || line.length > 40) continue;
    if (!/^[\p{L}][\p{L}.' -]*$/u.test(line)) continue;
    const words = line.split(' ').filter(Boolean);
    if (words.length < 2 || words.length > 4) continue;
    if (/\b(resume|résumé|curriculum|vitae|cv|profile|summary|objective|contact|experience|education|skills|address|personal|details)\b/i.test(line)) continue;
    return tidyName(line);
  }
  return null;
}

export function regexExtract(text: string): Partial<ParsedCandidate> {
  const email = normalizeEmail(text.match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0]);
  const phoneMatches = text.match(/(?:\+?\d[\d\s().-]{8,16}\d)/g) ?? [];
  const phones = [...new Set(phoneMatches.map((p) => normalizePhone(p)).filter((p): p is string => !!p && p.length >= 11 && p.length <= 16))];
  const linkedin = text.match(/(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9_-]+/i)?.[0];
  const github = text.match(/(?:https?:\/\/)?github\.com\/[A-Za-z0-9_-]+/i)?.[0];
  const exp = text.match(/(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:total\s+)?(?:work\s+|professional\s+|industry\s+)?experience/i);
  return {
    fullName: guessNameFromText(text),
    email,
    phone: phones[0] ?? null,
    altPhone: phones[1] ?? null,
    linkedinUrl: linkedin ? url(linkedin) : null,
    githubUrl: github ? url(github) : null,
    totalExpMonths: exp ? Math.round(parseFloat(exp[1]) * 12) : null,
  };
}

/** Extract the first JSON object from an LLM reply (tolerates ```json fences / prose). */
export function extractJsonObject(text: string): any | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

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
