import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

import { EMAIL_CATALOG } from './email-catalog';
import { NOTIFICATION_EMAIL } from './notification-catalog';

const ctx = { orgName: 'Nugen IT Services', frontendUrl: 'https://nugenova.com' };
const keys = new Set(EMAIL_CATALOG.map((e) => e.key));

describe('EMAIL_CATALOG', () => {
  it('has unique keys', () => {
    expect(keys.size).toBe(EMAIL_CATALOG.length);
  });

  it.each(EMAIL_CATALOG.map((e) => [e.key, e] as const))('previews %s', (_key, entry) => {
    const { subject, html } = entry.preview(ctx);
    expect(subject.trim().length).toBeGreaterThan(0);
    expect(html).toMatch(/<[a-z]/i);
  });

  // "Every kind of email must have a preview": these fail when an email is added
  // without a catalog entry, before it reaches production unseen.
  it('covers every notification type that sends an email', () => {
    // Registered but never sent by any code path today.
    const unused = new Set(['security_new_signin', 'security_mfa_changed']);
    const missing = Object.keys(NOTIFICATION_EMAIL).filter((t) => !unused.has(t) && !keys.has(t));
    expect(missing).toEqual([]);
  });

  it('covers every directly-sent email category found in the code', () => {
    const src = join(__dirname, '..', '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts') && !full.endsWith('.spec.ts') && !full.endsWith('e2e-spec.ts')) files.push(full);
      }
    };
    walk(src);
    // Only what an email send actually passes: the `category` of a mail.send({…})
    // call, or the category argument of AttendanceCronService's email() helper.
    // (Plain `category:` fields elsewhere — file uploads, activity rows — aren't emails.)
    const found = new Set<string>();
    for (const f of files) {
      const code = readFileSync(f, 'utf8');
      for (const call of code.matchAll(/mail\??\.send\(/g)) {
        const block = code.slice(call.index!, call.index! + 1200);
        const cat = /category:\s*'([a-z0-9_.-]+)'/.exec(block.split(/mail\??\.send\(/)[1] ?? '');
        if (cat && cat[1] !== 'notification' && cat[1] !== 'security') found.add(cat[1]);
      }
      for (const call of code.matchAll(/this\.email\(/g)) {
        const block = code.slice(call.index!, call.index! + 800);
        const cat = /'([a-z]+\.[a-z_]+)'/.exec(block);
        if (cat) found.add(cat[1]);
      }
    }
    // Sanity: the scan must actually be finding sends, or this test proves nothing.
    expect([...found]).toEqual(expect.arrayContaining(['attendance.daily_digest', 'attendance.absent', 'org-invite', 'error-alert']));
    // `security` is one category shared by three distinct alerts.
    expect(keys.has('otp')).toBe(true);
    expect(['security.new_signin', 'security.mfa_enabled', 'security.mfa_disabled'].every((k) => keys.has(k))).toBe(true);
    expect([...found].filter((c) => !keys.has(c))).toEqual([]);
  });
});
