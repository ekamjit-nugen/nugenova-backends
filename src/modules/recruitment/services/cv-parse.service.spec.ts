import { NotFoundException } from '@nestjs/common';
import { CvParseService } from './cv-parse.service';
import { RecruitmentCaller } from './recruitment-caller';

const caller: RecruitmentCaller = { userId: 'u1', orgId: 'org1', isAdmin: true, actions: [] };
const CV = 'Aviral Sharma\nsharmaaviral743@gmail.com  +91 8889839544\nData Engineer at Ascentt, Indore\nSkills: SQL, Python, Power BI';

function build(opts: { aiText?: string; aiError?: Error; fileOrg?: string; bytes?: string } = {}) {
  const file = { id: 'f1', organizationId: opts.fileOrg ?? 'org1', originalName: 'Cutshort-Aviral-Sharma-DE-x1.txt', mimeType: 'text/plain' };
  const storage = { getMeta: jest.fn().mockResolvedValue(file), getBytes: jest.fn().mockResolvedValue(Buffer.from(opts.bytes ?? CV)) };
  const ai = {
    complete: opts.aiError ? jest.fn().mockRejectedValue(opts.aiError) : jest.fn().mockResolvedValue({ text: opts.aiText ?? '{}' }),
  };
  const qb: any = { where: () => qb, andWhere: () => qb, orderBy: () => qb, take: () => qb, getMany: jest.fn().mockResolvedValue([]) };
  const candidates = { createQueryBuilder: () => qb };
  const svc = new CvParseService(storage as any, ai as any, candidates as any);
  return { svc, ai, storage };
}

describe('CvParseService', () => {
  const previous = process.env.RECRUITMENT_CV_AI;
  afterEach(() => {
    if (previous === undefined) delete process.env.RECRUITMENT_CV_AI; else process.env.RECRUITMENT_CV_AI = previous;
  });

  it('reads CVs without AI by default: name, contact details, no external call, no warning', async () => {
    delete process.env.RECRUITMENT_CV_AI;
    const { svc, ai } = build();
    const res = await svc.parse(caller, 'f1');
    expect(ai.complete).not.toHaveBeenCalled();
    expect(res.engine).toBe('regex');
    expect(res.warning).toBeNull();
    expect(res.source).toBe('cutshort');
    expect(res.extracted).toMatchObject({ fullName: 'Aviral Sharma', email: 'sharmaaviral743@gmail.com', phone: '+918889839544' });
  });

  it('uses the model output, sanitised, and tags Cutshort files', async () => {
    process.env.RECRUITMENT_CV_AI = 'on';
    const { svc, ai } = build({
      aiText: '```json\n{"fullName":"AVIRAL SHARMA","emails":["SharmaAviral743@gmail.com"],"phones":["8889839544"],"totalExpMonths":40,"skills":["SQL","Python","sql"],"summary":"Data engineer."}\n```',
    });
    const res = await svc.parse(caller, 'f1');
    expect(ai.complete).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ feature: 'recruitment_cv_parse', temperature: 0 }), { organizationId: 'org1', userId: 'u1' });
    expect(res.engine).toBe('ai');
    expect(res.parseStatus).toBe('parsed');
    expect(res.source).toBe('cutshort');
    expect(res.extracted).toMatchObject({ fullName: 'Aviral Sharma', email: 'sharmaaviral743@gmail.com', phone: '+918889839544', totalExpMonths: 40, skills: ['SQL', 'Python'], aiSummary: 'Data engineer.' });
  });

  it('falls back to regex extraction when the model is unavailable', async () => {
    process.env.RECRUITMENT_CV_AI = 'on';
    const { svc } = build({ aiError: new Error('AI service is temporarily unavailable') });
    const res = await svc.parse(caller, 'f1');
    expect(res.engine).toBe('regex');
    expect(res.parseStatus).toBe('partial');
    expect(res.warning).toMatch(/unavailable/);
    expect(res.extracted.email).toBe('sharmaaviral743@gmail.com');
    expect(res.extracted.phone).toBe('+918889839544');
  });

  it('never calls the model when skipAi is set or the file has no text', async () => {
    process.env.RECRUITMENT_CV_AI = 'on';
    const a = build();
    await a.svc.parse(caller, 'f1', { skipAi: true });
    expect(a.ai.complete).not.toHaveBeenCalled();
    const b = build({ bytes: '   ' });
    const res = await b.svc.parse(caller, 'f1');
    expect(b.ai.complete).not.toHaveBeenCalled();
    expect(res.parseStatus).toBe('no_text');
  });

  it('refuses a file from another organization', async () => {
    const { svc } = build({ fileOrg: 'org2' });
    await expect(svc.parse(caller, 'f1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
