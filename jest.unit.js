export default {
  displayName: 's3mini unit test',
  silent: false,
  verbose: true,
  collectCoverage: false,
  testEnvironment: 'node',
  maxWorkers: 'auto',
  testTimeout: 10000,
  testMatch: [
    '<rootDir>/tests/presigned-url.test.js',
    '<rootDir>/tests/extract-bucket-name.test.js',
    '<rootDir>/tests/parse-xml.test.js',
    '<rootDir>/tests/versioning.test.js',
    '<rootDir>/tests/list-pagination.test.js',
  ],
  transform: {
    '\\.[jt]sx?$': ['babel-jest', { presets: ['@babel/preset-typescript'] }],
  },
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
