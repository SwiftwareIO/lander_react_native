/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/plugin'],
  testMatch: ['**/*.test.ts', '**/*.test.js'],
  modulePathIgnorePatterns: ['<rootDir>/example/', '<rootDir>/lib/'],
  // The tests never load the real react-native package; each suite mocks what it needs.
  transformIgnorePatterns: ['/node_modules/'],
}
