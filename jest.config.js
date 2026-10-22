// `unit` needs no database; `integration` runs against an in-memory mongod.
process.env.MONGO_MEMORY_SERVER_FILE ??= 'jest-mongodb-config.cjs'

const common = { transform: {} } // native ESM

export default {
  projects: [
    { displayName: 'unit', ...common, testMatch: ['<rootDir>/test/unit/**/*.test.js'] },
    { displayName: 'integration', ...common, preset: '@shelf/jest-mongodb', testMatch: ['<rootDir>/test/integration/**/*.test.js'] }
  ]
}
