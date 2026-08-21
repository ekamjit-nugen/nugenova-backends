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
  passWithNoTests: true,
};
