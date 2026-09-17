/**
 * The wording of the account-security alert emails. Shared by AuthService (the
 * real send) and the Roles page preview, so the preview shows the exact text.
 */
export interface SecurityAlertCopy {
  title: string;
  intro: string;
  rows?: Array<{ label: string; value: string }>;
}

export const SECURITY_ALERT_COPY = {
  newSignin: (device: { label: string; ipAddress?: string | null; when: string }): SecurityAlertCopy => ({
    title: 'New sign-in to your account',
    intro: `Your Nugenova account was just accessed from a device we haven't seen before.`,
    rows: [
      { label: 'Device', value: device.label },
      ...(device.ipAddress ? [{ label: 'IP address', value: device.ipAddress }] : []),
      { label: 'When', value: device.when },
    ],
  }),
  mfaEnabled: (): SecurityAlertCopy => ({
    title: 'Two-factor authentication enabled',
    intro:
      "Two-factor authentication was just turned on for your Nugenova account. From now on you'll enter a code from your authenticator app when you sign in.",
  }),
  mfaDisabled: (): SecurityAlertCopy => ({
    title: 'Two-factor authentication disabled',
    intro:
      'Two-factor authentication was just turned off for your Nugenova account. Your account is now protected by the sign-in code alone.',
  }),
};

/** Button shown on every security alert. */
export const SECURITY_ALERT_CTA = { text: 'Review security', path: '/settings/security' };
