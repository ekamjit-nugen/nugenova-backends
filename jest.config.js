/** Unit + integration tests (*.spec.ts under src/). */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@bootstrap/(.*)$': '<rootDir>/bootstrap/$1',
    '^@modules/(.*)$': '<rootDir>/modules/$1',
  },
  passWithNoTests: true,
};
