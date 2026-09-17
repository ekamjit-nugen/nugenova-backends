import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';

import { AllExceptionsFilter } from './all-exceptions.filter';

/**
 * Unit specs for the global filter — no Nest app, just the contract: what the
 * caller is told, and what gets handed to the reporter.
 */
describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let reporter: { report: jest.Mock };
  let res: { status: jest.Mock; json: jest.Mock };
  let req: any;

  const host = () =>
    ({
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    }) as any;

  beforeEach(() => {
    reporter = { report: jest.fn().mockResolvedValue(undefined) };
    res = { status: jest.fn(() => res), json: jest.fn(() => res) } as any;
    req = {
      method: 'POST',
      originalUrl: '/api/v1/leaves',
      ip: '10.0.0.4',
      headers: {},
      user: { userId: 'u1', organizationId: 'org1', email: 'bob@acme.test' },
    };
    filter = new AllExceptionsFilter(reporter as any);
  });

  const body = () => res.json.mock.calls.at(-1)![0];
  const reported = () => reporter.report.mock.calls.at(-1)![0];

  it('hides the reason from the caller on a 500 but reports it in full', () => {
    filter.catch(new Error('column "title" does not exist'), host());

    expect(res.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(body().message).toBe('Something went wrong on our side. The team has been notified.');
    expect(body().message).not.toContain('column');
    expect(body().reference).toMatch(/^[0-9a-f]{8}$/);

    expect(reported().status).toBe(500);
    expect(reported().message).toBe('column "title" does not exist');
    expect(reported().stack).toContain('Error: column "title" does not exist');
    expect(reported().reference).toBe(body().reference);
  });

  it('keeps a 4xx message, which the UI shows to the user', () => {
    filter.catch(new ForbiddenException('You cannot edit this member'), host());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(body().message).toBe('You cannot edit this member');
    expect(reported().status).toBe(403);
  });

  it('flattens a validation error list into one message', () => {
    filter.catch(new BadRequestException(['name must be a string', 'age must be a number']), host());

    expect(reported().message).toBe('name must be a string; age must be a number');
    // The caller still receives the original array-shaped body.
    expect(body().message).toEqual(['name must be a string', 'age must be a number']);
  });

  it('carries who and where into the report', () => {
    filter.catch(new Error('boom'), host());

    expect(reported()).toEqual(
      expect.objectContaining({
        method: 'POST',
        path: '/api/v1/leaves',
        organizationId: 'org1',
        userId: 'u1',
        userEmail: 'bob@acme.test',
        ip: '10.0.0.4',
      }),
    );
  });

  it('prefers the forwarded client ip behind a proxy', () => {
    req.headers['x-forwarded-for'] = '203.0.113.7, 10.0.0.1';
    filter.catch(new Error('boom'), host());
    expect(reported().ip).toBe('203.0.113.7');
  });

  it('reports an anonymous failure with no org or user', () => {
    req.user = undefined;
    filter.catch(new Error('boom'), host());
    expect(reported().organizationId).toBeNull();
    expect(reported().userId).toBeNull();
  });

  it('handles a thrown non-Error', () => {
    filter.catch('something odd', host());
    expect(reported().message).toBe('something odd');
    expect(reported().stack).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('handles an HttpException carrying a plain string', () => {
    filter.catch(new HttpException('teapot', 418), host());
    expect(res.status).toHaveBeenCalledWith(418);
    expect(body()).toEqual(expect.objectContaining({ statusCode: 418, message: 'teapot' }));
  });

  it('answers the caller even when reporting rejects', async () => {
    reporter.report.mockRejectedValue(new Error('activity table is gone'));
    expect(() => filter.catch(new Error('boom'), host())).not.toThrow();
    await Promise.resolve();
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('does not try to answer a non-http context', () => {
    const wsHost = { switchToHttp: () => ({ getRequest: () => ({}), getResponse: () => ({}) }) } as any;
    expect(() => filter.catch(new Error('boom'), wsHost)).not.toThrow();
    expect(reporter.report).not.toHaveBeenCalled();
  });
});
