import { UserModel } from "./models/users.js"

const API_PREFIX = '/api'

const routes = ( fastify, opts, done ) => {
  fastify.register(AutoCrud, {
    url: `${API_PREFIX}/users`,
    Model: UserModel
  })
  done()
}

export {
  routes
}