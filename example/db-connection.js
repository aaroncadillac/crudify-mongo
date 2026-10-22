import mongoose from 'mongoose'

// MONGODB_URL is the full connection string, e.g. mongodb://localhost:27017/crudify-example
const dbConnection = async (fastify) => {
  await mongoose.connect(process.env.MONGODB_URL)
  fastify.log.info('Connected to database')
  fastify.addHook('onClose', () => mongoose.disconnect())
}

export { dbConnection }
