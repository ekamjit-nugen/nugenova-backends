/**
 * Deterministic, explainable candidate ↔ target scoring (0–100) for talent-pool
 * suggestions. Pure — no I/O; see matching.spec.ts.
 *
 * Weights: skills 60 · experience 20 · notice vs needed-by 10 · location 10.
 * Missing information on either side is neutral (half credit), never a penalty,
 * so sparse imported profiles still surface.
 */

export interface MatchCandidate {
  skills: string[];
  totalExpMonths: number | null;
  noticePeriodDays: number | null;
  noticeStatus: string;
  currentLocation: string | null;
  preferredLocations: string[];
  status: string;
}

export interface MatchTarget {
  skills: string[];
  expMinYears?: number | null;
  expMaxYears?: number | null;
  location?: string | null;
  workMode?: string | null;
  /** Date the client/opening needs the person by. */
  neededBy?: Date | string | null;
}

export interface MatchScore {
  score: number;
  reasons: string[];
  matchedSkills: string[];
}

/** Common spellings → one canonical token. */
const ALIASES: Record<string, string> = {
  spark: 'pyspark', 'apache spark': 'pyspark',
  powerbi: 'power bi', 'ms power bi': 'power bi',
  js: 'javascript', ts: 'typescript', node: 'node.js', nodejs: 'node.js',
  reactjs: 'react', 'react.js': 'react', nextjs: 'next.js', vuejs: 'vue', 'vue.js': 'vue', angularjs: 'angular',
  postgres: 'postgresql', psql: 'postgresql', mongo: 'mongodb', k8s: 'kubernetes',
  'amazon web services': 'aws', 'google cloud': 'gcp', 'microsoft azure': 'azure',
  golang: 'go', 'c sharp': 'c#', csharp: 'c#', '.net core': '.net', dotnet: '.net',
  ml: 'machine learning', dl: 'deep learning', genai: 'generative ai', 'gen ai': 'generative ai', llms: 'llm',
  'sap abap': 'abap', 'ms sql': 'sql server', mssql: 'sql server', 't-sql': 'sql server',
};

export function normalizeSkill(s: string): string {
  const k = s.toLowerCase().replace(/\s+/g, ' ').trim();
  return ALIASES[k] ?? k;
}

const cityOf = (s: string | null | undefined) =>
  (s ?? '').toLowerCase().split(/[,/(|-]/)[0].replace(/\s+/g, ' ').trim();

export function scoreMatch(c: MatchCandidate, t: MatchTarget, now = new Date()): MatchScore | null {
  if (c.status === 'blacklisted' || c.status === 'archived') return null;
  const reasons: string[] = [];

  // ── skills (60) ──
  const want = [...new Set(t.skills.map(normalizeSkill).filter(Boolean))];
  const have = new Set(c.skills.map(normalizeSkill));
  const haveList = [...have];
  const matched = want.filter((w) => have.has(w) || haveList.some((h) => h.length > 2 && w.length > 2 && (h.includes(w) || w.includes(h))));
  let skills: number;
  if (!want.length) skills = 30;
  else if (!have.size) skills = 15;
  else skills = Math.round((matched.length / want.length) * 60);
  if (want.length && matched.length) reasons.push(`${matched.length}/${want.length} skills: ${matched.slice(0, 4).join(', ')}`);
  else if (want.length && have.size) reasons.push('No matching skills');

  // ── experience (20) ──
  let exp = 10;
  const min = t.expMinYears != null ? t.expMinYears * 12 : null;
  const max = t.expMaxYears != null ? t.expMaxYears * 12 : null;
  if (c.totalExpMonths != null && (min != null || max != null)) {
    const years = Math.round((c.totalExpMonths / 12) * 10) / 10;
    if ((min == null || c.totalExpMonths >= min) && (max == null || c.totalExpMonths <= max)) {
      exp = 20;
      reasons.push(`${years} yrs fits ${t.expMinYears ?? 0}–${t.expMaxYears ?? '∞'}`);
    } else {
      const gap = min != null && c.totalExpMonths < min ? min - c.totalExpMonths : max != null ? c.totalExpMonths - max : 0;
      exp = gap <= 12 ? 12 : gap <= 24 ? 6 : 0;
      reasons.push(`${years} yrs vs ${t.expMinYears ?? 0}–${t.expMaxYears ?? '∞'} required`);
    }
  }

  // ── notice vs needed-by (10) ──
  let notice = 5;
  const days = c.noticeStatus === 'immediate' ? 0 : c.noticePeriodDays;
  if (days != null) {
    if (t.neededBy) {
      const daysLeft = Math.ceil((new Date(t.neededBy).getTime() - now.getTime()) / 86_400_000);
      notice = days <= Math.max(daysLeft, 0) ? 10 : days - daysLeft <= 15 ? 5 : 0;
      reasons.push(days === 0 ? 'Immediate joiner' : days <= daysLeft ? `Can join in ${days}d (needed in ${Math.max(daysLeft, 0)}d)` : `${days}d notice, needed in ${Math.max(daysLeft, 0)}d`);
    } else {
      notice = days <= 30 ? 10 : days <= 60 ? 6 : 3;
      if (days <= 30) reasons.push(days === 0 ? 'Immediate joiner' : `${days}d notice`);
    }
  }

  // ── location (10) ──
  let loc = 5;
  if (t.workMode === 'remote') { loc = 10; }
  else if (t.location) {
    const wanted = t.location.split(/[,/|]/).map((x) => cityOf(x)).filter(Boolean);
    const places = [c.currentLocation, ...c.preferredLocations].map(cityOf).filter(Boolean);
    if (places.length) {
      const hit = wanted.some((w) => places.some((p) => p.includes(w) || w.includes(p)));
      loc = hit ? 10 : 2;
      if (hit) reasons.push(`Location fits ${t.location}`);
    }
  }

  return { score: Math.max(0, Math.min(100, skills + exp + notice + loc)), reasons, matchedSkills: matched };
}
