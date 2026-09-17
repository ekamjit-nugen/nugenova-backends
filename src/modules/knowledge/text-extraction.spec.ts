import { extractText, sanitizeExtractedText } from './text-extraction';

const NUL = String.fromCharCode(0);

describe('sanitizeExtractedText', () => {
  it('removes NUL bytes that Postgres rejects (custom-font PDF headings)', () => {
    const raw = `ANMOL KUMAR SHARMA\nS${NUL.repeat(5)} C${NUL.repeat(3)} | P${NUL.repeat(4)} BI\n+91 99061 52344`;
    const out = sanitizeExtractedText(raw);
    expect(out.includes(NUL)).toBe(false);
    expect(out).toBe('ANMOL KUMAR SHARMA\nS C | P BI\n+91 99061 52344');
  });

  it('drops other control characters, lone surrogates and replacement chars but keeps tabs, newlines and emoji', () => {
    const bell = String.fromCharCode(7);
    const unitSep = String.fromCharCode(0x1f);
    const replacement = String.fromCharCode(0xfffd);
    const loneHigh = String.fromCharCode(0xd800);
    const smile = String.fromCodePoint(0x1f600);
    const out = sanitizeExtractedText(`a${bell}b${unitSep}c\tdone\r\nline${replacement} ${smile} x${loneHigh}y`);
    expect(out).toBe(`abc\tdone\r\nline ${smile} xy`);
  });

  it('collapses the gaps removed glyphs leave behind and trims', () => {
    expect(sanitizeExtractedText('   Power      BI   ')).toBe('Power  BI');
  });
});

describe('extractText', () => {
  it('returns clean text for text files', async () => {
    const res = await extractText(Buffer.from('Skills: SQL, Power BI\nNotice: 30 days'), 'cv.txt', 'text/plain');
    expect(res.status).toBe('ok');
    expect(res.text).toBe('Skills: SQL, Power BI\nNotice: 30 days');
  });
});
