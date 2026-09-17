import {
  cleanCell, cleanList, experienceFromHistory, extractJsonObject, isCutshortFileName, looksLikeSheetNote, normalizeEmail, normalizePhone,
  guessNameFromText, normalizeSource, parseExperienceMonths, parseLegacyRemarks, parseNotice, regexExtract, sanitizeParsedCandidate,
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

  it('experienceFromHistory merges overlapping ranges', () => {
    const now = new Date(2026, 0, 1);
    const months = experienceFromHistory([
      { company: 'A', designation: null, from: '2020-01', to: '2023-01', current: false, summary: null },
      { company: 'B', designation: null, from: '2022-01', to: null, current: true, summary: null },
    ], now);
    expect(months).toBe(72);
  });

  describe('sanitizeParsedCandidate', () => {
    it('normalises and drops junk', () => {
      const out = sanitizeParsedCandidate({
        fullName: 'AKASH SHAW', emails: ['Akash.PShaw524@gmail.com'], phones: ['9804753101', '+91 98047 53101', '8888888888'],
        totalExperience: '7 years', noticePeriod: '30 days', skills: ['SQL', 'sql', 'Power BI'],
        linkedinUrl: 'linkedin.com/in/akash', githubUrl: 'https://evil.example.com/x', currentCtc: '12,00,000',
        workHistory: [{ company: 'Acme', designation: 'Engineer', from: '2019', to: 'Present', current: true }],
        education: [{ degree: 'B.Tech', institution: 'IIT' }, { foo: 'bar' }],
      });
      expect(out.fullName).toBe('Akash Shaw');
      expect(out.email).toBe('akash.pshaw524@gmail.com');
      expect(out.phone).toBe('+919804753101');
      expect(out.altPhone).toBe('+918888888888');
      expect(out.totalExpMonths).toBe(84);
      expect(out.noticePeriodDays).toBe(30);
      expect(out.skills).toEqual(['SQL', 'Power BI']);
      expect(out.linkedinUrl).toBe('https://linkedin.com/in/akash');
      expect(out.githubUrl).toBeNull();
      expect(out.currentCtc).toBe(1200000);
      expect(out.currentCompany).toBe('Acme');
      expect(out.education).toHaveLength(1);
      expect(out.highestQualification).toBe('B.Tech');
    });
    it('reads CTC given in lakhs', () => {
      expect(sanitizeParsedCandidate({ currentCtc: 18, expectedCtc: '26 LPA' })).toMatchObject({ currentCtc: 1800000, expectedCtc: 2600000 });
    });
    it('survives garbage input', () => {
      expect(sanitizeParsedCandidate(null).fullName).toBeNull();
      expect(sanitizeParsedCandidate('x' as any).skills).toEqual([]);
    });
  });

  it('regexExtract finds contact details', () => {
    const r = regexExtract('John Doe\njohn.doe@mail.com | +91 98765 43210\nlinkedin.com/in/johndoe\n6+ years of experience in data');
    expect(r.email).toBe('john.doe@mail.com');
    expect(r.phone).toBe('+919876543210');
    expect(r.linkedinUrl).toBe('https://linkedin.com/in/johndoe');
    expect(r.totalExpMonths).toBe(72);
  });

  it('extractJsonObject tolerates fences and prose', () => {
    expect(extractJsonObject('Here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('{"a": {"b": 2}} trailing')).toEqual({ a: { b: 2 } });
    expect(extractJsonObject('nope')).toBeNull();
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

describe('guessNameFromText', () => {
  it('reads the name printed at the top of a CV', () => {
    expect(guessNameFromText('ANMOL KUMAR SHARMA\nS C | P BI\nNoida, UP 201003 ◆ +91 - 9906152344')).toBe('Anmol Kumar Sharma');
    expect(guessNameFromText('Curriculum Vitae\nPriya S. Nair\npriya@example.com')).toBe('Priya S. Nair');
  });
  it('skips headings, contact lines and long sentences', () => {
    expect(guessNameFromText('Professional Summary\nemail: a@b.com\nSeasoned data analytics professional with 8 years of experience')).toBeNull();
    expect(guessNameFromText('')).toBeNull();
  });
});
