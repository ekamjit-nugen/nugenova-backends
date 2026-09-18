/**
 * Error areas — which part of the app a failed request came from, so the
 * Activity page can show "errors people hit in Recruitment". An area is derived
 * from the API path's first segment (`/api/v1/recruitment/...` → recruitment).
 */
export interface ErrorArea {
  key: string;
  label: string;
  /** First path segments after `/api/v1/` that belong to this area. */
  segments: string[];
}

export const ERROR_AREAS: ErrorArea[] = [
  { key: 'recruitment', label: 'Recruitment', segments: ['recruitment'] },
  { key: 'sales', label: 'Sales', segments: ['sales'] },
  { key: 'clients', label: 'Clients', segments: ['clients'] },
  { key: 'attendance', label: 'Attendance & timesheets', segments: ['attendance', 'holidays', 'timesheets'] },
  { key: 'leave', label: 'Leave', segments: ['leaves'] },
  { key: 'payroll', label: 'Payroll', segments: ['payroll'] },
  { key: 'policies', label: 'Policies', segments: ['policies'] },
  { key: 'people', label: 'People & roles', segments: ['org', 'onboarding'] },
  { key: 'chat', label: 'Chat', segments: ['chat'] },
  { key: 'meetings', label: 'Meetings', segments: ['meetings'] },
  { key: 'calendar', label: 'Calendar', segments: ['calendar'] },
  { key: 'boards', label: 'Boards', segments: ['discussion-boards'] },
  { key: 'drive', label: 'Cloud Drive', segments: ['storage'] },
  { key: 'notifications', label: 'Notifications', segments: ['notifications', 'push'] },
  { key: 'account', label: 'Sign-in & account', segments: ['auth', 'consent'] },
  { key: 'ai', label: 'AI assistant', segments: ['ai'] },
  { key: 'learning', label: 'Academics', segments: ['academic', 'lms', 'assessment', 'guardian'] },
  { key: 'other', label: 'Other', segments: [] },
];

const BY_KEY = new Map(ERROR_AREAS.map((a) => [a.key, a]));
const BY_SEGMENT = new Map(ERROR_AREAS.flatMap((a) => a.segments.map((s) => [s, a.key] as const)));

/** The first path segment after `/api/v1/` (query string ignored), or '' . */
export function firstSegment(path: string | null | undefined): string {
  const clean = String(path ?? '').split('?')[0];
  const m = /^\/api\/v\d+\/([^/]+)/.exec(clean);
  return (m?.[1] ?? '').toLowerCase();
}

/** The area a request path belongs to (unknown paths → 'other'). */
export function areaForPath(path: string | null | undefined): string {
  return BY_SEGMENT.get(firstSegment(path)) ?? 'other';
}

export function isErrorArea(key: unknown): key is string {
  return typeof key === 'string' && BY_KEY.has(key);
}

/** Map a path segment (or a stored area key) to its area key. */
export function areaKeyOf(segmentOrArea: string | null | undefined): string {
  const v = String(segmentOrArea ?? '').toLowerCase();
  if (BY_KEY.has(v) && v !== 'other') return v;
  return BY_SEGMENT.get(v) ?? 'other';
}

export function areaLabel(key: string): string {
  return BY_KEY.get(key)?.label ?? 'Other';
}
