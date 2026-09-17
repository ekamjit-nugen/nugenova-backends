import { ERROR_AREAS, areaForPath, areaKeyOf, firstSegment } from './error-areas';

describe('error areas', () => {
  it('reads the first API path segment, ignoring the query string', () => {
    expect(firstSegment('/api/v1/recruitment/candidates/abc/documents')).toBe('recruitment');
    expect(firstSegment('/api/v1/timesheets?status=submitted')).toBe('timesheets');
    expect(firstSegment('/health')).toBe('');
  });

  it('puts each request in the part of the app it came from', () => {
    expect(areaForPath('/api/v1/recruitment/candidates?pool=pipeline')).toBe('recruitment');
    expect(areaForPath('/api/v1/attendance/stats?startDate=x')).toBe('attendance');
    expect(areaForPath('/api/v1/timesheets')).toBe('attendance');
    expect(areaForPath('/api/v1/leaves/pending')).toBe('leave');
    expect(areaForPath('/api/v1/org/members')).toBe('people');
    expect(areaForPath('/api/v1/auth/verify-otp')).toBe('account');
    expect(areaForPath('/api/v1/vertical/pack')).toBe('other');
    expect(areaForPath(undefined)).toBe('other');
  });

  it('maps both stored area keys and old path segments', () => {
    expect(areaKeyOf('attendance')).toBe('attendance');
    expect(areaKeyOf('holidays')).toBe('attendance');
    expect(areaKeyOf('discussion-boards')).toBe('boards');
    expect(areaKeyOf(null)).toBe('other');
  });

  it('never assigns a path segment to two areas', () => {
    const segments = ERROR_AREAS.flatMap((a) => a.segments);
    expect(new Set(segments).size).toBe(segments.length);
  });
});
