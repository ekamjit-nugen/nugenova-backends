import {
  cleanCell, cleanList, isCutshortFileName, looksLikeSheetNote, normalizeEmail, normalizePhone,
  normalizeSource, parseExperienceMonths, parseLegacyRemarks, parseNotice,
  tidyCompany, tidyName, toPrefixTsQuery,
} from './recruitment.utils';

describe('recruitment.utils', () => {
  describe('cleanCell', () => {
    it.each(['—', '–', '-', 'N/A', 'na', '  ', '', 'Not mentioned', null, undefined])('treats %p as blank', (v) => {
      expect(cleanCell(v)).toBeNull();
    });
    it('collapses whitespace', () => expect(cleanCell('  Noida \n  UP ')).toBe('Noida UP'));
  });

  describe('normalizePhone', () => {
    it.each([
      ['+91 9804753101', '+919804753101'],
      ['7089185437', '+917089185437'],
      ['91-8699069378', '+918699069378'],
      ['09560971604', '+919560971604'],
      ['+1 (415) 555-0100', '+14155550100'],
    ])('%s → %s', (input, out) => expect(normalizePhone(input)).toBe(out));
    it('rejects too-short and placeholders', () => {
      expect(normalizePhone('12345')).toBeNull();
      expect(normalizePhone('—')).toBeNull();
    });
  });

  describe('normalizeEmail', () => {
    it('lower-cases and extracts', () => expect(normalizeEmail(' Shivamrathor478@Gmail.com ')).toBe('shivamrathor478@gmail.com'));
    it('rejects non-emails', () => expect(normalizeEmail('Email not found')).toBeNull());
  });

  describe('parseExperienceMonths', () => {
    it.each([
      ['5+ years', 60], ['5+years', 60], ['7 years', 84], ['24 Years', 288], ['3 years 6 months', 42],
      ['1.5 yrs', 18], ['8 months', 8], ['fresher', 0], ['10', 120], ['—', null], ['lots', null],
    ])('%s → %p', (input, out) => expect(parseExperienceMonths(input)).toBe(out));
  });

  describe('parseNotice', () => {
    it.each([
      ['Immediate Joiner', { days: 0, status: 'immediate' }],
      ['immediate', { days: 0, status: 'immediate' }],
      ['30 days', { days: 30, status: 'fixed' }],
      ['2 months', { days: 60, status: 'fixed' }],
      ['Serving notice - 15 days left', { days: 15, status: 'serving' }],
      ['negotiable', { days: null, status: 'negotiable' }],
      ['—', { days: null, status: 'unknown' }],
    ])('%s', (input, out) => expect(parseNotice(input)).toEqual(out));
  });

  describe('normalizeSource', () => {
    it('maps common labels', () => {
      expect(normalizeSource('Cutshort')).toBe('cutshort');
      expect(normalizeSource('LinkedIn Jobs')).toBe('linkedin');
      expect(normalizeSource('Employee referral')).toBe('referral');
      expect(normalizeSource('Data Engineer Profiles')).toBe('other');
      expect(normalizeSource('')).toBeNull();
    });
  });

  it('tidyName title-cases shouting / lower names only', () => {
    expect(tidyName('SASIKALA. M')).toBe('Sasikala. M');
    expect(tidyName('uday ps thakur')).toBe('Uday Ps Thakur');
    expect(tidyName('McDonald Rao')).toBe('McDonald Rao');
  });

  it('cleanList de-duplicates case-insensitively', () => {
    expect(cleanList('Python, SQL; python | Power BI')).toEqual(['Python', 'SQL', 'Power BI']);
  });

  it('isCutshortFileName', () => {
    expect(isCutshortFileName('Cutshort-SagarYadav-Power-BI-Developer-June26-xvG6.pdf')).toBe(true);
    expect(isCutshortFileName('resume.pdf')).toBe(false);
  });

  describe('parseLegacyRemarks', () => {
    it('splits role, source and drops boilerplate', () => {
      expect(parseLegacyRemarks('[BI Developer - SQL, Python, PLX] Source: Data Engineer BI Developer SQL Python PLX; Notice period not mentioned'))
        .toEqual({ role: 'BI Developer - SQL, Python, PLX', sourceLabel: 'Data Engineer BI Developer SQL Python PLX', notes: null });
    });
    it('keeps human notes', () => {
      expect(parseLegacyRemarks('Source: resume; Notice period not mentioned; Duplicate candidate - multiple versions'))
        .toEqual({ role: null, sourceLabel: 'resume', notes: 'Duplicate candidate - multiple versions' });
    });
  });

  it('tidyCompany strips date ranges and "Currently at"', () => {
    expect(tidyCompany('Charger Logistics Inc.July 2022 – Present')).toBe('Charger Logistics Inc.');
    expect(tidyCompany('Appwrk IT Solutions Pvt. Ltd. Aug 2022 – Aug 2025')).toBe('Appwrk IT Solutions Pvt. Ltd.');
    expect(tidyCompany('Currently at Yash Technologies as Senior Power BI')).toBe('Yash Technologies as Senior Power BI');
  });

  it('toPrefixTsQuery sanitises input', () => {
    expect(toPrefixTsQuery('Power BI  dev!')).toBe('power:* & bi:* & dev:*');
    expect(toPrefixTsQuery("'; drop table --")).toBe('drop:* & table:*');
    expect(toPrefixTsQuery('  ')).toBeNull();
  });
});

describe('looksLikeSheetNote', () => {
  it('flags sheet footers, banners and totals', () => {
    expect(looksLikeSheetNote('Total candidates in this sheet: 10')).toBe(true);
    expect(looksLikeSheetNote('Generated: Candidate_Summary_by_Capability.xlsx | Auto-extracted - please verify contact details before outreach')).toBe(true);
    expect(looksLikeSheetNote('Grand Total')).toBe(true);
    expect(looksLikeSheetNote('Count: 23')).toBe(true);
    expect(looksLikeSheetNote('12/09/2026')).toBe(true);
  });
  it('keeps real names', () => {
    for (const n of ['Dinesh Kumar', 'Sasikala. M', 'Krati', "D'Souza, Anita", 'Mohd. Arif Khan', 'Totaram Singh', 'Noteworthy Sharma']) {
      expect(looksLikeSheetNote(n)).toBe(false);
    }
    expect(looksLikeSheetNote(null)).toBe(false);
  });
});
