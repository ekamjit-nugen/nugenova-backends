import type {
  WorkTimingConfig,
  WorkLocationConfig,
  WfhConfig,
  PolicyCategory,
} from './entities/policy.entity';

/**
 * The DEFAULT org work-timing — seeded (applicableTo: all) for every new org so
 * that a work-timing policy ALWAYS applies to every employee before any
 * attendance is recorded. Matches the monolith's "Standard Work Timing 9AM–6PM".
 * This is the "required policy" that governs clock-in/out until an admin adds
 * department/specific overrides.
 */
export const DEFAULT_ORG_WORK_TIMING: WorkTimingConfig = {
  startTime: '09:00',
  endTime: '18:00',
  timezone: 'Asia/Kolkata',
  graceMinutes: 15,
  minWorkingHours: 8,
  breakMinutes: 60,
  lateToHalfDayMinutes: 120,
  minHoursForPresent: 4,
  isNightShift: false,
};

export interface PolicyTemplateDef {
  templateName: string;
  policyName: string;
  category: PolicyCategory;
  description: string;
  workTiming?: WorkTimingConfig;
  workLocation?: WorkLocationConfig;
  wfhConfig?: WfhConfig;
  /**
   * Default for the cloned policy's acknowledgement gate. Location-tracking
   * templates default to `true` so every employee the policy is attached to must
   * consent (to being geo-located at clock-in) before it takes effect.
   */
  acknowledgementRequired?: boolean;
}

/**
 * The attendance-governing templates an admin can clone. (The monolith seeds 19
 * global templates across every category; this phase seeds the timing/location/
 * WFH ones that drive attendance — the rest arrive with their modules.)
 */
export const POLICY_TEMPLATES: PolicyTemplateDef[] = [
  {
    templateName: 'Standard Work Timing 9AM–6PM',
    policyName: 'Standard Work Timing',
    category: 'working_hours',
    description: 'A standard 9:00–18:00 working day with a 15-minute grace.',
    workTiming: { ...DEFAULT_ORG_WORK_TIMING },
  },
  {
    templateName: 'Work From Office (Geo-fenced, 2 km)',
    policyName: 'Work From Office',
    category: 'attendance',
    description: 'Clock-in must be inside the office geo-fence.',
    workTiming: { ...DEFAULT_ORG_WORK_TIMING },
    workLocation: { mode: 'office', geoFenceRadiusKm: 2, offices: [] },
    // Location tracking → employees must consent before it applies.
    acknowledgementRequired: true,
  },
  {
    templateName: 'Work From Home (Anywhere)',
    policyName: 'Work From Home',
    category: 'attendance',
    description: 'No location check — clock in from anywhere.',
    workTiming: { ...DEFAULT_ORG_WORK_TIMING },
    workLocation: { mode: 'home' },
  },
  {
    templateName: 'Hybrid Work (allowed days)',
    policyName: 'Hybrid Work',
    category: 'attendance',
    description: 'Location recorded but not enforced; WFH on allowed days.',
    workTiming: { ...DEFAULT_ORG_WORK_TIMING },
    workLocation: { mode: 'hybrid' },
    wfhConfig: { maxDaysPerMonth: 8, requiresApproval: true, allowedDays: ['monday', 'friday'] },
  },
  {
    templateName: 'Night Shift (9PM–6AM)',
    policyName: 'Night Shift',
    category: 'attendance',
    description: 'An overnight shift that straddles midnight.',
    workTiming: {
      ...DEFAULT_ORG_WORK_TIMING,
      startTime: '21:00',
      endTime: '06:00',
      isNightShift: true,
    },
    workLocation: { mode: 'office', geoFenceRadiusKm: 2, offices: [] },
    acknowledgementRequired: true,
  },
];
