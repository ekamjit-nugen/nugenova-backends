/**
 * End-to-end / integration tests (*.e2e-spec.ts). These boot a Nest app via
 * supertest against an isolated Postgres schema and bind the Gherkin .feature
 * files with jest-cucumber. Wired fully with the first migrated module (auth).
 */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.e2e-spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@bootstrap/(.*)$': '<rootDir>/src/bootstrap/$1',
    '^@modules/(.*)$': '<rootDir>/src/modules/$1',
  },
  // Provision the auth schema once (idempotent) before any app boots.
  globalSetup: '<rootDir>/test/global-setup.ts',
  // Serialize files: the target Postgres is SHARED (Supabase locally), so avoid
  // parallel connection storms and fixture races across the e2e specs.
  maxWorkers: 1,
  // Supabase (local dev) adds real network latency per request; a scenario that
  // provisions multiple orgs + members does many round-trips. 60s keeps the
  // heaviest multi-org setups from flaking without masking real hangs.
  testTimeout: 60000,
};
