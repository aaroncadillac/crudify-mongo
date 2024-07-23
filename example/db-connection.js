import mongoose from 'mongoose';

const dbConnection = async ( fastify ) => {
  try {
    await mongoose.connect(`${process.env.MONGODB_URL}/${process.env.MONGO_DATABASE}${process.env.MONGO_OPTIONS && `?${process.env.MONGO_OPTIONS}`}`);
    fastify.log.info('Connected to database');
  }
  catch (error) {
    fastify.log.error('Error connecting to database');
  }
}

export {
  dbConnection
}