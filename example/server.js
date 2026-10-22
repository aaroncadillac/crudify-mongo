import { buildApp } from './app.js'
import { dbConnection } from './db-connection.js'

// node --env-file=.env example/server.js   (.env: MONGODB_URL=mongodb://localhost:27017/crudify-example)
const app = await buildApp({ logger: true })
await app.register(dbConnection)

app.listen({ port: process.env.PORT || 3000, host: process.env.HOST || 'localhost' }, (err) => {
  if (err) {
    app.log.error(err)
    process.exit(1)
  }
})
