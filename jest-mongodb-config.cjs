// Read by @shelf/jest-mongodb (see MONGO_MEMORY_SERVER_FILE in jest.config.js).
// Set MONGOMS_SYSTEM_BINARY=$(command -v mongod) to use a local mongod and skip the download.
module.exports = {
  mongodbMemoryServerOptions: {
    binary: { version: '7.0.14', skipMD5: true },
    autoStart: false,
    instance: {}
  },
  useSharedDBForAllJestWorkers: false
}
