import 'dotenv/config';
import Fastify from 'fastify'
import { dbConnection } from './db-connection.js';
import { routes } from './routes.js';

const fastify = Fastify({
  logger: true
})

fastify.register(await dbConnection)
fastify.register(routes)

fastify.listen({ port: process.env.PORT || 3000, host: process.env.HOST || 'localhost' }, function (err, address) {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
})


