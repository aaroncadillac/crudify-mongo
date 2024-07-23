export default {
  preset: '@shelf/jest-mongodb',
  transformIgnorePatterns: [
    '<rootDir>/node_modules/fastify/',
    '<rootDir>/crudify.js'
  ]
};