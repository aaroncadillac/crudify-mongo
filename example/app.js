import Fastify from 'fastify'
import fastifyAuth from '@fastify/auth'
import { Crudify, CrudifyError } from '@aaroncadillac/crudify-mongo'
import { PostsModel } from './models/posts.js'
import { UserModel } from './models/users.js'

// Crudify does not authenticate anyone: it gives you two seams, `authorize`
// and `scope`, and your auth tool of choice (here @fastify/auth) fills them.
// The "database" of tokens below is a stand-in for real JWT / session checks.
const TOKENS = {
  'token-ana': { id: 'u1', accountId: 'A', role: 'admin' },
  'token-ben': { id: 'u2', accountId: 'B', role: 'viewer' }
}

const unauthorized = () => Object.assign(new Error('Unauthorized'), { statusCode: 401 })

const buildApp = async ({ logger = false } = {}) => {
  const app = Fastify({ logger })

  await app.register(fastifyAuth)
  app.decorateRequest('user', null)
  app.decorate('verifyBearer', async (req) => {
    const user = TOKENS[req.headers.authorization?.replace('Bearer ', '')]
    if (!user) throw unauthorized()
    req.user = user
  })

  // Shared by every resource: authentication runs first (a Fastify preHandler),
  // then Crudify's authorize -> scope.
  const secured = {
    routeOptions: { preHandler: app.auth([app.verifyBearer]) },
    // each account only ever sees and writes its own documents
    scope: (req) => ({ accountId: req.user.accountId }),
    // viewers can read; writes need the admin role
    authorize: (req, action) => {
      const writes = !['list', 'get'].includes(action)
      if (writes && req.user.role !== 'admin') throw new CrudifyError(403, 'admins only', { code: 'admin_required' })
    }
  }

  app.register(Crudify, { ...secured, url: '/users', Model: UserModel, serialize: (doc) => doc })
  app.register(Crudify, {
    ...secured,
    url: '/posts',
    Model: PostsModel,
    fields: { readonly: ['status'] }, // status only changes through the publish action
    actions: {
      publish: {
        handler: async (req, reply, ctx) => {
          const post = req.crudify.doc // loaded with the same scope + authorize
          post.status = 'published'
          await post.save()
          return ctx.serialize(post, req)
        }
      }
    }
  })

  return app
}

export { buildApp, TOKENS }
