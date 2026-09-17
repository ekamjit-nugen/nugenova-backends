import { BadRequestException } from '@nestjs/common';

import { sanitizeDashboardLayout } from './dashboard-layout.service';

describe('sanitizeDashboardLayout', () => {
  it('keeps well-formed section ids in order, once each', () => {
    expect(sanitizeDashboardLayout({ order: ['attention', 'team-today', 'attention', 'sales'], hidden: ['sales'] })).toEqual({
      order: ['attention', 'team-today', 'sales'],
      hidden: ['sales'],
    });
  });

  it('drops ids that are not plain section names', () => {
    expect(sanitizeDashboardLayout({ order: ['<script>', 'Upper', '', 42, 'ok-1'], hidden: [null] })).toEqual({
      order: ['ok-1'],
      hidden: [],
    });
  });

  it('treats missing lists as empty', () => {
    expect(sanitizeDashboardLayout({})).toEqual({ order: [], hidden: [] });
    expect(sanitizeDashboardLayout(null)).toEqual({ order: [], hidden: [] });
  });

  it('refuses a list that is not a list, or is too long', () => {
    expect(() => sanitizeDashboardLayout({ order: 'attention' })).toThrow(BadRequestException);
    const many = Array.from({ length: 41 }, (_, i) => `s${i}`);
    expect(() => sanitizeDashboardLayout({ hidden: many })).toThrow(BadRequestException);
  });
});
