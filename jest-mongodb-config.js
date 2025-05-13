export default {
  mongodbMemoryServerOptions: {
    binary: {
      version: '4.0.3',
      skipMD5: true,
    },
    autoStart: false,
    instance: {},
    replSet: false
  },
  useSharedDBForAllJestWorkers: false,
};