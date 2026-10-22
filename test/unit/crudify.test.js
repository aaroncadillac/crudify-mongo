import { describe, it, expect, afterEach, jest } from '@jest/globals'
import { readFileSync, existsSync } from 'node:fs'
import mongoose from 'mongoose'
import paginate from 'mongoose-paginate-v2'
import { Crudify, CrudifyError } from '../../crudify.js'
import { FASTIFIES } from '../helpers/fastifies.js'
import { boot, enc } from '../helpers/client.js'

// Core behaviour with the Mongoose model stubbed: the assertions are about the
// exact filters / options / updates that would reach Mongo.
// Covers C1-C15, C20 and the Igor needs table (see CHANGELOG for the full map).

const ID = '64b7f0a2c3d4e5f607182930'
const doc = { _id: ID, name: 'n' }

const schema = new mongoose.Schema({
  name: { type: String, required: true },
  accountId: String,
  secret: { type: String, select: false }
}, { timestamps: true })
schema.plugin(paginate)
const Thing = mongoose.model('Thing', schema)

const stamped = new mongoose.Schema({ name: String }, { timestamps: { createdAt: 'created', updatedAt: 'modified' } })
stamped.plugin(paginate)
const Stamped = mongoose.model('Stamped', stamped)

const placed = new mongoose.Schema({
  name: String,
  tableIds: [String],
  restaurantId: String,
  accountId: String
}, { timestamps: true })
placed.plugin(paginate)
const Placed = mongoose.model('Placed', placed)

const stubModel = (Model = Thing) => ({
  paginate: jest.spyOn(Model, 'paginate').mockResolvedValue({ docs: [doc], totalDocs: 1, limit: 50, page: 1 }),
  findOne: jest.spyOn(Model, 'findOne').mockResolvedValue(doc),
  update: jest.spyOn(Model, 'findOneAndUpdate').mockResolvedValue(doc),
  remove: jest.spyOn(Model, 'findOneAndDelete').mockResolvedValue(doc),
  create: jest.spyOn(Model, 'create').mockImplementation(async (d) => Array.isArray(d) ? d : { _id: ID, ...d }),
  insertMany: jest.spyOn(Model, 'insertMany').mockImplementation(async (d) => d)
})

const serve = (Fastify, opts = {}, { before, fastifyOptions, Model = Thing } = {}) =>
  boot(Fastify, async (app) => {
    before?.(app)
    app.register(Crudify, { url: '/things', Model, scope: false, ...opts })
  }, fastifyOptions)

afterEach(() => { jest.restoreAllMocks() })

describe.each(FASTIFIES)('%s · Crudify (stubbed model)', (_, Fastify) => {
  let server
  const start = async (...args) => (server = await serve(Fastify, ...args))
  afterEach(async () => { await server?.close(); server = null })

  describe('reads (C1, C2, C3, C20)', () => {
    it('lists with safe defaults: page 1, limit 50, pagination on', async () => {
      const m = stubModel()
      const { req } = await start()
      const res = await req({ url: '/things' })
      expect(res.statusCode).toBe(200)
      expect(res.json().docs).toHaveLength(1)
      expect(m.paginate).toHaveBeenCalledWith({}, { page: 1, limit: 50, pagination: true })
    })

    it('rejects $where without touching the model (C1)', async () => {
      const m = stubModel()
      const { req } = await start()
      const res = await req({ url: `/things?filters=${enc({ $where: '1' })}` })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ status: 400, error: 'Bad Request', code: 'invalid_query' })
      expect(m.paginate).not.toHaveBeenCalled()
    })

    it.each([['{oops'], [enc([1])], [enc({ a: { $regex: 'x' } })]])('rejects malformed or dangerous filters (%s)', async (raw) => {
      const m = stubModel()
      const { req } = await start()
      expect((await req({ url: `/things?filters=${raw}` })).statusCode).toBe(400)
      expect(m.paginate).not.toHaveBeenCalled()
    })

    it('escapes the "/text/" search instead of building a client regex (C2)', async () => {
      const m = stubModel()
      const { req } = await start()
      await req({ url: `/things?filters=${enc({ name: '/a.*b/' })}` })
      const filter = m.paginate.mock.calls[0][0]
      expect(filter.name.source).toBe('a\\.\\*b')
      expect(filter.name.flags).toBe('i')
    })

    it('caps the limit and forwards nothing but page / limit / sort (C3)', async () => {
      const m = stubModel()
      const { req } = await start()
      const options = { limit: 5000, page: 2, sort: '-name', populate: 'x', select: '+secret', lean: true, pagination: false }
      await req({ url: `/things?options=${enc(options)}` })
      expect(m.paginate.mock.calls[0][1]).toEqual({ page: 2, limit: 100, pagination: true, sort: { name: -1 } })
    })

    it('honours query overrides', async () => {
      const m = stubModel()
      const { req } = await start({ query: { defaultLimit: 10, maxLimit: 20 } })
      await req({ url: '/things' })
      await req({ url: `/things?options=${enc({ limit: 999 })}` })
      expect(m.paginate.mock.calls.map(c => c[1].limit)).toEqual([10, 20])
    })

    it('does not let select:false fields be filtered or sorted (C20)', async () => {
      const m = stubModel()
      const { req } = await start()
      expect((await req({ url: `/things?filters=${enc({ secret: { $gt: 'a' } })}` })).statusCode).toBe(400)
      expect((await req({ url: `/things?options=${enc({ sort: 'secret' })}` })).statusCode).toBe(400)
      expect(m.paginate).not.toHaveBeenCalled()
    })

    it('forwards lean and a fixed select to paginate / findOne', async () => {
      const m = stubModel()
      const { req } = await start({ lean: true, select: 'name' })
      await req({ url: '/things' })
      await req({ url: `/things/${ID}` })
      expect(m.paginate.mock.calls[0][1]).toMatchObject({ lean: true, select: 'name' })
      expect(m.findOne).toHaveBeenCalledWith({ _id: ID }, 'name', { lean: true })
    })

    it('does not reuse option objects across requests (C24)', async () => {
      const m = stubModel()
      const { req } = await start()
      await req({ url: '/things' })
      await req({ url: '/things' })
      const [a, b] = m.paginate.mock.calls
      expect(a[1]).toEqual(b[1])
      expect(a[1]).not.toBe(b[1])
      expect(a[0]).not.toBe(b[0])
    })
  })

  describe('scope on every verb (C4)', () => {
    const scope = () => ({ accountId: 'A' })

    it('ANDs the scope with get / update / delete by id', async () => {
      const m = stubModel()
      const { req } = await start({ scope })
      await req({ url: `/things/${ID}` })
      await req({ method: 'PUT', url: `/things/${ID}`, payload: { name: 'x' } })
      await req({ method: 'DELETE', url: `/things/${ID}` })
      expect(m.findOne.mock.calls[0][0]).toEqual({ _id: ID, accountId: 'A' })
      expect(m.update.mock.calls[0][0]).toEqual({ _id: ID, accountId: 'A' })
      expect(m.update.mock.calls[0][2]).toMatchObject({ returnDocument: 'after', runValidators: true })
      expect(m.remove.mock.calls[0][0]).toEqual({ _id: ID, accountId: 'A' })
    })

    it('a document outside the scope is a plain 404', async () => {
      const m = stubModel()
      m.findOne.mockResolvedValue(null)
      m.update.mockResolvedValue(null)
      m.remove.mockResolvedValue(null)
      const { req } = await start({ scope })
      for (const method of ['GET', 'PUT', 'DELETE']) {
        const res = await req({ method, url: `/things/${ID}`, payload: method === 'PUT' ? { name: 'x' } : undefined })
        expect(res.statusCode).toBe(404)
        expect(res.json()).toEqual({ status: 404, error: 'Not Found', message: `ID: ${ID} not found` })
      }
    })

    it('a client filter on a scope key cannot override the scope in list', async () => {
      const m = stubModel()
      const { req } = await start({ scope })
      await req({ url: `/things?filters=${enc({ accountId: 'B' })}` })
      expect(m.paginate.mock.calls[0][0]).toEqual({ $and: [{ accountId: 'B' }, { accountId: 'A' }] })
    })

    it('merges disjoint keys without a $and', async () => {
      const m = stubModel()
      const { req } = await start({ scope })
      await req({ url: `/things?filters=${enc({ name: 'x' })}` })
      expect(m.paginate.mock.calls[0][0]).toEqual({ name: 'x', accountId: 'A' })
    })

    it('answers 404 to an invalid id without touching the database', async () => {
      const m = stubModel()
      const { req } = await start({ scope })
      for (const method of ['GET', 'PUT', 'DELETE']) {
        expect((await req({ method, url: '/things/not-an-id', payload: method === 'PUT' ? { name: 'x' } : undefined })).statusCode).toBe(404)
      }
      expect(m.findOne).not.toHaveBeenCalled()
      expect(m.update).not.toHaveBeenCalled()
      expect(m.remove).not.toHaveBeenCalled()
    })

    it('fails closed when scope does not return an object', async () => {
      const m = stubModel()
      const { req } = await start({ scope: () => undefined })
      expect((await req({ url: '/things' })).statusCode).toBe(403)
      expect((await req({ url: `/things/${ID}` })).statusCode).toBe(403)
      expect(m.paginate).not.toHaveBeenCalled()
      expect(m.findOne).not.toHaveBeenCalled()
    })

    it('an empty object means "no restriction", explicitly', async () => {
      const m = stubModel()
      const { req } = await start({ scope: () => ({}) })
      expect((await req({ url: '/things' })).statusCode).toBe(200)
      expect(m.paginate).toHaveBeenCalled()
    })

    it('forces equality scope keys into new documents and ignores the client value', async () => {
      const m = stubModel()
      const { req } = await start({ scope })
      const res = await req({ method: 'POST', url: '/things', payload: { name: 'x', accountId: 'B' } })
      expect(res.statusCode).toBe(201)
      expect(m.create).toHaveBeenCalledWith({ name: 'x', accountId: 'A' })
    })

    it('for { $in } scopes the client value must be present and allowed', async () => {
      const m = stubModel()
      const { req } = await start({ scope: () => ({ accountId: { $in: ['A', 'B'] } }) })
      expect((await req({ method: 'POST', url: '/things', payload: { name: 'x' } })).statusCode).toBe(400)
      expect((await req({ method: 'POST', url: '/things', payload: { name: 'x', accountId: 'Z' } })).statusCode).toBe(403)
      expect((await req({ method: 'POST', url: '/things', payload: { name: 'x', accountId: 'B' } })).statusCode).toBe(201)
      expect(m.create).toHaveBeenCalledTimes(1)
      expect(m.create).toHaveBeenCalledWith({ name: 'x', accountId: 'B' })
    })

    it('never lets an update move a document out of its scope', async () => {
      const m = stubModel()
      const { req } = await start({ scope })
      await req({ method: 'PUT', url: `/things/${ID}`, payload: { name: 'x', accountId: 'B' } })
      expect(m.update.mock.calls[0][1]).toEqual({ name: 'x' })
    })
  })

  describe('writes (C5, C6, C14)', () => {
    it('strips protected fields and operators from updates (C5)', async () => {
      const m = stubModel()
      const { req } = await start()
      await req({ method: 'PUT', url: `/things/${ID}`, payload: { name: 'x', _id: 'other', createdAt: 1, __v: 9 } })
      expect(m.update.mock.calls[0][1]).toEqual({ name: 'x' })
      expect((await req({ method: 'PUT', url: `/things/${ID}`, payload: { $rename: { name: 'secret' } } })).statusCode).toBe(400)
      expect((await req({ method: 'PUT', url: `/things/${ID}`, payload: { name: { $gt: 1 } } })).statusCode).toBe(400)
      expect(m.update).toHaveBeenCalledTimes(1)
    })

    it('rejects an update with nothing valid left', async () => {
      const m = stubModel()
      const { req } = await start()
      const res = await req({ method: 'PUT', url: `/things/${ID}`, payload: { _id: 'x' } })
      expect(res.statusCode).toBe(400)
      expect(m.update).not.toHaveBeenCalled()
    })

    it('honours fields.writable / fields.readonly', async () => {
      const m = stubModel()
      const { req } = await start({ fields: { writable: ['name'], readonly: ['accountId'] } })
      await req({ method: 'POST', url: '/things', payload: { name: 'x', accountId: 'Z', secret: 's' } })
      expect(m.create).toHaveBeenCalledWith({ name: 'x' })
    })

    it('custom timestamp names are read-only too', async () => {
      const m = stubModel(Stamped)
      const { req } = await start({ Model: Stamped, url: '/stamped' }, { Model: Stamped })
      await req({ method: 'PUT', url: `/stamped/${ID}`, payload: { name: 'x', created: 1, modified: 2 } })
      expect(m.update.mock.calls[0][1]).toEqual({ name: 'x' })
    })

    it('bulk create goes through Model.create so save hooks run (C6)', async () => {
      const m = stubModel()
      const { req } = await start()
      const res = await req({ method: 'POST', url: '/things', payload: [{ name: 'a' }, { name: 'b' }] })
      expect(res.statusCode).toBe(201)
      expect(res.json()).toEqual({ message: 'All documents created successfully' })
      expect(m.create).toHaveBeenCalledWith([{ name: 'a' }, { name: 'b' }])
      expect(m.insertMany).not.toHaveBeenCalled()
    })

    it('insertMany is an explicit opt-in', async () => {
      const m = stubModel()
      const { req } = await start({ bulk: { insertMany: true } })
      await req({ method: 'POST', url: '/things', payload: [{ name: 'a' }] })
      expect(m.insertMany).toHaveBeenCalled()
      expect(m.create).not.toHaveBeenCalled()
    })

    it('validates the whole bulk first: one invalid item inserts nothing', async () => {
      const m = stubModel()
      const { req } = await start()
      const res = await req({ method: 'POST', url: '/things', payload: [{ name: 'ok' }, {}] })
      expect(res.statusCode).toBe(400)
      expect(res.json().message).toBe('Fields: [name] are required and cannot be empty')
      expect(m.create).not.toHaveBeenCalled()
    })

    it('bounds the bulk size (C14): 413 over max, 400 when empty or disabled', async () => {
      const m = stubModel()
      const { req } = await start({ bulk: { max: 2 } })
      const over = await req({ method: 'POST', url: '/things', payload: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] })
      expect(over.statusCode).toBe(413)
      expect(over.json().message).toBe('Too many items (max 2)')
      expect((await req({ method: 'POST', url: '/things', payload: [] })).statusCode).toBe(400)
      expect((await req({ method: 'POST', url: '/things', payload: 'x' })).statusCode).toBe(400)
      expect(m.create).not.toHaveBeenCalled()
      await server.close()
      const off = await start({ bulk: false })
      expect((await off.req({ method: 'POST', url: '/things', payload: [{ name: 'a' }] })).statusCode).toBe(400)
    })
  })

  describe('errors (C7, C8)', () => {
    it('maps E11000 to a generic 409 and logs only the fields', async () => {
      const logs = []
      const m = stubModel()
      m.create.mockRejectedValue(Object.assign(new Error('E11000 duplicate key error collection: db.things index: name_1 dup key: { name: "x@y.z" }'), { code: 11000, keyPattern: { name: 1 } }))
      const { req } = await start({}, { fastifyOptions: { logger: { level: 'info', stream: { write: (l) => logs.push(l) } } } })
      const res = await req({ method: 'POST', url: '/things', payload: { name: 'x' } })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'duplicate_key', message: 'Duplicate key' })
      expect(res.body).not.toMatch(/x@y\.z|db\.things|name_1/)
      const logged = logs.join('')
      expect(logged).toContain('duplicate key')
      expect(logged).not.toContain('x@y.z')
    })

    it('hides unexpected errors behind "Internal error" and logs the real one', async () => {
      const logs = []
      const m = stubModel()
      m.paginate.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5 password=hunter2'))
      const { req } = await start({}, { fastifyOptions: { logger: { level: 'info', stream: { write: (l) => logs.push(l) } } } })
      const res = await req({ url: '/things' })
      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual({ status: 500, error: 'Internal Server Error', message: 'Internal error' })
      expect(logs.join('')).toContain('hunter2') // the server log keeps the detail
    })

    it('uses the same body shape for validation errors on every verb (C8)', async () => {
      const m = stubModel()
      const invalid = Object.assign(new Error('internal'), { name: 'ValidationError', errors: { name: { kind: 'required' } } })
      m.create.mockRejectedValue(invalid)
      m.update.mockRejectedValue(invalid)
      const { req } = await start()
      const post = await req({ method: 'POST', url: '/things', payload: { x: 1 } })
      const put = await req({ method: 'PUT', url: `/things/${ID}`, payload: { x: 1 } })
      for (const res of [post, put]) {
        expect(res.statusCode).toBe(400)
        expect(res.json()).toEqual({ status: 400, error: 'Bad Request', message: 'Fields: [name] are required and cannot be empty', code: 'validation_error' })
      }
    })

    it('mapError overrides the default; returning undefined falls back to it', async () => {
      const m = stubModel()
      m.paginate.mockRejectedValue(new Error('x'))
      const { req } = await start({ mapError: (err) => err.message === 'x' ? { status: 418, body: { teapot: true } } : undefined })
      const res = await req({ url: '/things' })
      expect(res.statusCode).toBe(418)
      expect(res.json()).toEqual({ teapot: true })
      expect((await req({ url: '/things/bad-id' })).statusCode).toBe(404)
    })

    it('mapError:false leaves error handling to the application', async () => {
      stubModel()
      const { req } = await start({ mapError: false, scope: () => undefined }, {
        before: (app) => app.setErrorHandler((err, request, reply) => reply.code(418).send({ app: err.statusCode }))
      })
      const res = await req({ url: '/things' })
      expect(res.statusCode).toBe(418)
      expect(res.json()).toEqual({ app: 403 })
    })
  })

  describe('hooks, authorize and serialize (C9)', () => {
    it('runs authorize -> scope -> before -> operation -> after -> serialize in order', async () => {
      const trace = []
      const m = stubModel()
      m.create.mockImplementation(async (d) => { trace.push('create'); return { _id: ID, ...d } })
      const { req } = await start({
        authorize: (r, action) => { trace.push(`authorize:${action}`) },
        scope: (r, action) => { trace.push(`scope:${action}`); return { accountId: 'A' } },
        hooks: {
          beforeCreate: (d) => { trace.push('before'); return { ...d, touched: true } },
          afterCreate: () => { trace.push('after') }
        },
        serialize: (d) => { trace.push('serialize'); return { id: d._id } }
      })
      const res = await req({ method: 'POST', url: '/things', payload: { name: 'x' } })
      expect(res.statusCode).toBe(201)
      expect(res.json()).toEqual({ id: ID })
      expect(trace).toEqual(['authorize:create', 'scope:create', 'before', 'create', 'after', 'serialize'])
      expect(m.create).toHaveBeenCalledWith({ name: 'x', accountId: 'A', touched: true })
    })

    it('authorize can deny by throwing or by returning false, before any I/O', async () => {
      const m = stubModel()
      const { req } = await start({ authorize: (r, a) => { if (a === 'delete') throw new (class extends Error { statusCode = 403 })('no deletes'); return a !== 'update' } })
      expect((await req({ method: 'PUT', url: `/things/${ID}`, payload: { name: 'x' } })).statusCode).toBe(403)
      const del = await req({ method: 'DELETE', url: `/things/${ID}` })
      expect(del.statusCode).toBe(403)
      expect(del.json().message).toBe('no deletes')
      expect((await req({ url: '/things' })).statusCode).toBe(200)
      expect(m.update).not.toHaveBeenCalled()
      expect(m.remove).not.toHaveBeenCalled()
    })

    it('hooks can stop the request with a CrudifyError and receive the right arguments', async () => {
      const m = stubModel()
      const seen = {}
      const { req } = await start({
        hooks: {
          beforeUpdate: (changes) => { seen.update = changes; return { ...changes, name: 'forced' } },
          afterUpdate: (d) => { seen.after = d },
          beforeDelete: (d) => { seen.delete = d; throw new CrudifyError(409, 'in use', { code: 'in_use' }) },
          afterList: (result) => ({ ...result, extra: 1 })
        }
      })
      await req({ method: 'PUT', url: `/things/${ID}`, payload: { name: 'x' } })
      expect(seen.update).toEqual({ name: 'x' })
      expect(m.update.mock.calls[0][1]).toEqual({ name: 'forced' })
      expect(seen.after).toBe(doc)
      const del = await req({ method: 'DELETE', url: `/things/${ID}` })
      expect(del.statusCode).toBe(409)
      expect(del.json()).toMatchObject({ code: 'in_use', message: 'in use' })
      expect(seen.delete).toBe(doc)
      expect(m.remove).not.toHaveBeenCalled() // beforeDelete stopped it
      expect((await req({ url: '/things' })).json().extra).toBe(1)
    })

    it('deletes with a single query when there is no beforeDelete hook', async () => {
      const m = stubModel()
      const { req } = await start()
      await req({ method: 'DELETE', url: `/things/${ID}` })
      expect(m.findOne).not.toHaveBeenCalled()
      expect(m.remove).toHaveBeenCalledTimes(1)
    })

    it('serialize applies to get, update, delete and every listed doc', async () => {
      stubModel()
      const { req } = await start({ serialize: (d) => ({ id: d._id }) })
      expect((await req({ url: `/things/${ID}` })).json()).toEqual({ id: ID })
      expect((await req({ method: 'PUT', url: `/things/${ID}`, payload: { name: 'x' } })).json()).toEqual({ id: ID })
      expect((await req({ method: 'DELETE', url: `/things/${ID}` })).json()).toEqual({ id: ID })
      expect((await req({ url: '/things' })).json().docs).toEqual([{ id: ID }])
    })
  })

  describe('methods, custom routes and overrides (C10, C11)', () => {
    it('only registers the requested verbs (C10)', async () => {
      stubModel()
      const { req } = await start({ methods: ['list', 'get'] })
      expect((await req({ url: '/things' })).statusCode).toBe(200)
      expect((await req({ method: 'POST', url: '/things', payload: { name: 'x' } })).statusCode).toBe(404)
      expect((await req({ method: 'PUT', url: `/things/${ID}`, payload: {} })).statusCode).toBe(404)
      expect((await req({ method: 'DELETE', url: `/things/${ID}` })).statusCode).toBe(404)
    })

    it('replaces a single verb with handlers.<verb> and keeps authorize + scope', async () => {
      const m = stubModel()
      const { req } = await start({
        scope: () => ({ accountId: 'A' }),
        handlers: { create: async (r, reply, ctx) => reply.code(201).send({ custom: true, scope: r.crudify.filter, hasWhere: typeof ctx.where }) }
      })
      const res = await req({ method: 'POST', url: '/things', payload: { name: 'x' } })
      expect(res.json()).toEqual({ custom: true, scope: { accountId: 'A' }, hasWhere: 'function' })
      expect(m.create).not.toHaveBeenCalled()
      expect((await req({ url: '/things' })).statusCode).toBe(200)
    })

    it('routes(api, ctx) adds custom routes that share scope, authorize and errors', async () => {
      const m = stubModel()
      const authorized = []
      const { req } = await start({
        authorize: (r, action) => { authorized.push(action) },
        scope: () => ({ accountId: 'A' }),
        routes: (api) => {
          api.get('/stats', { action: 'list' }, async (r, reply, ctx) => ({ filter: await ctx.where(r, 'list', { name: 'x' }) }))
          api.get('/:id/light', { load: true }, async (r) => ({ got: r.crudify.doc._id }))
          api.post('/boom', async () => { throw new Error('secret') })
        }
      })
      expect((await req({ url: '/things/stats' })).json()).toEqual({ filter: { name: 'x', accountId: 'A' } })
      expect((await req({ url: `/things/${ID}/light` })).json()).toEqual({ got: ID })
      expect(m.findOne.mock.calls[0][0]).toEqual({ _id: ID, accountId: 'A' })
      const boom = await req({ method: 'POST', url: '/things/boom' })
      expect(boom.statusCode).toBe(500)
      expect(boom.json().message).toBe('Internal error')
      expect(authorized).toEqual(['list', 'get', 'update'])
    })

    it('actions load the scoped document and authorize by action name', async () => {
      const m = stubModel()
      const seen = []
      const { req } = await start({
        authorize: (r, action) => { seen.push(action); return action !== 'archive' },
        scope: () => ({ accountId: 'A' }),
        actions: {
          close: { handler: async (r) => ({ closed: r.crudify.doc._id }) },
          archive: { method: 'PUT', path: '/:id/archive', handler: async () => ({}) }
        }
      })
      expect((await req({ method: 'POST', url: `/things/${ID}/close` })).json()).toEqual({ closed: ID })
      expect(m.findOne.mock.calls[0][0]).toEqual({ _id: ID, accountId: 'A' })
      expect((await req({ method: 'PUT', url: `/things/${ID}/archive` })).statusCode).toBe(403)
      m.findOne.mockResolvedValue(null)
      expect((await req({ method: 'POST', url: `/things/${ID}/close` })).statusCode).toBe(404)
      expect(seen).toEqual(['close', 'archive', 'close'])
    })

    it('exposes req.crudify = { action, filter, doc } to application hooks', async () => {
      stubModel()
      let snapshot
      const { req } = await start({ scope: () => ({ accountId: 'A' }) }, {
        before: (app) => app.addHook('onResponse', async (r) => { snapshot = { action: r.crudify.action, filter: r.crudify.filter } })
      })
      await req({ url: '/things' })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(snapshot).toEqual({ action: 'list', filter: { accountId: 'A' } })
    })

    it('rejects the removed additionalRoutes option at registration (both old forms)', async () => {
      stubModel()
      await expect(serve(Fastify, { additionalRoutes: [{ method: 'GET', url: '/ping', handler: async () => ({}) }] })).rejects.toThrow(/additionalRoutes.*removed/)
      await expect(serve(Fastify, { additionalRoutes: () => {} })).rejects.toThrow(/routes|actions/)
    })
  })

  describe('registration (C12, C13, C15, C18, C19, validation)', () => {
    it('does not leak plugin options into the Fastify routes (C12)', async () => {
      stubModel()
      const routes = []
      await start({ routeOptions: { config: { tag: 1 } } }, { before: (app) => app.addHook('onRoute', (r) => routes.push(r)) })
      const mine = routes.filter(r => r.url.startsWith('/things'))
      expect(mine.length).toBeGreaterThanOrEqual(5)
      for (const route of mine) {
        expect(route).not.toHaveProperty('Model')
        expect(route).not.toHaveProperty('JSONSchema')
        expect(route.config).toMatchObject({ tag: 1 })
      }
    })

    it('respects a per-verb Fastify schema supplied by the user (C12)', async () => {
      const m = stubModel()
      const { req } = await start({ schema: { update: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 3 } } } } } })
      expect((await req({ method: 'PUT', url: `/things/${ID}`, payload: { name: 'x' } })).statusCode).toBe(400)
      expect((await req({ method: 'PUT', url: `/things/${ID}`, payload: { name: 'xyz' } })).statusCode).toBe(200)
      expect(m.update).toHaveBeenCalledTimes(1)
    })

    const JSONSchema = {
      type: 'object',
      required: ['name'],
      properties: {
        _id: { type: 'string' }, name: { type: 'string' }, accountId: { type: 'string' },
        createdAt: { type: 'string' }, owner: { type: 'string', 'x-ref': 'Users' }
      }
    }

    it('JSONSchema: the list response has the paginate shape (C18)', async () => {
      stubModel()
      const { req } = await start({ JSONSchema })
      const body = (await req({ url: '/things' })).json()
      expect(body).toEqual({ docs: [{ _id: ID, name: 'n' }], totalDocs: 1, limit: 50, page: 1 })
    })

    it('JSONSchema: the body accepts one object or a bulk array (C19) and ignores x-ref', async () => {
      const m = stubModel()
      const { req } = await start({ JSONSchema })
      expect((await req({ method: 'POST', url: '/things', payload: { name: 'a' } })).statusCode).toBe(201)
      expect((await req({ method: 'POST', url: '/things', payload: [{ name: 'a' }, { name: 'b' }] })).statusCode).toBe(201)
      expect((await req({ method: 'POST', url: '/things', payload: {} })).statusCode).toBe(400)
      expect((await req({ method: 'POST', url: '/things', payload: [{}] })).statusCode).toBe(400)
      expect(m.create).toHaveBeenCalledTimes(2)
    })

    it('JSONSchema: read-only fields leave the body schema, so scope-forced keys are not required', async () => {
      const m = stubModel()
      const required = { ...JSONSchema, required: ['name', 'accountId'] }
      const { req } = await start({ JSONSchema: required, fields: { readonly: ['accountId'] }, scope: () => ({ accountId: 'A' }) })
      expect((await req({ method: 'POST', url: '/things', payload: { name: 'a' } })).statusCode).toBe(201)
      expect(m.create).toHaveBeenCalledWith({ name: 'a', accountId: 'A' })
    })

    it('registers under a prefix and inherits hooks of the parent (C15)', async () => {
      stubModel()
      const seen = []
      const s = await boot(Fastify, async (app) => {
        app.addHook('onRequest', async (r) => { seen.push(r.url) })
        app.register(Crudify, { url: '/things', Model: Thing, scope: false, prefix: '/api' })
      })
      expect((await s.req({ url: '/api/things' })).statusCode).toBe(200)
      expect(seen).toEqual(['/api/things'])
      await s.close()
    })

    it('can be registered twice for different models in the same app', async () => {
      stubModel()
      stubModel(Stamped)
      const s = await boot(Fastify, async (app) => {
        app.register(Crudify, { url: '/a', Model: Thing, scope: false })
        app.register(Crudify, { url: '/b', Model: Stamped, scope: false })
      })
      expect((await s.req({ url: '/a' })).statusCode).toBe(200)
      expect((await s.req({ url: '/b' })).statusCode).toBe(200)
      await s.close()
    })

    it('carries plugin metadata for Fastify 4 and 5', () => {
      expect(Crudify[Symbol.for('plugin-meta')]).toEqual({ name: 'crudify-mongo', fastify: '4.x || 5.x' })
      expect(Crudify[Symbol.for('fastify.display-name')]).toBe('crudify-mongo')
    })

    it.each([
      [{ url: undefined }, /`url` is required/],
      [{ Model: {} }, /Mongoose model/],
      [{ methods: ['list', 'nope'] }, /unknown method "nope"/],
      [{ hooks: { beforeCreate: 'x' } }, /`beforeCreate` must be a function/],
      [{ scope: 'x' }, /`scope` must be a function/],
      [{ strict: true, scope: undefined }, /strict/],
      [{ strict: true, scope: false, sanitizer: false }, /strict/],
      [{ query: { operators: ['$where'] } }, /not supported/]
    ])('fails fast on invalid options %j', async (bad, message) => {
      await expect(serve(Fastify, bad)).rejects.toThrow(message)
    })

    it('list needs mongoose-paginate-v2', async () => {
      const bare = mongoose.models.Bare ?? mongoose.model('Bare', new mongoose.Schema({ a: String }))
      await expect(serve(Fastify, { Model: bare })).rejects.toThrow(/paginate/)
      const s = await serve(Fastify, { Model: bare, methods: ['get'] })
      await s.close()
    })

    it('warns about a missing scope and a disabled sanitizer', async () => {
      const logs = []
      stubModel()
      const s = await serve(Fastify, { scope: undefined, sanitizer: false }, { fastifyOptions: { logger: { level: 'warn', stream: { write: (l) => logs.push(l) } } } })
      await s.close()
      expect(logs.join('')).toMatch(/no `scope`/)
      expect(logs.join('')).toMatch(/sanitizer disabled/)
    })

    it('sanitizer:false reproduces the raw 1.x behaviour', async () => {
      const m = stubModel()
      const { req } = await start({ sanitizer: false })
      await req({ url: `/things?filters=${enc({ name: '/a.b/' })}&options=${enc({ limit: 5000, populate: 'x' })}` })
      const [filter, options] = m.paginate.mock.calls[0]
      expect(filter.name.source).toBe('a.b') // unescaped, as in 1.x
      expect(options).toEqual({ limit: 5000, populate: 'x' })
      await req({ url: '/things' })
      expect(m.paginate.mock.calls[1][1]).toEqual({ pagination: false })
    })

    it('a custom sanitizer object replaces only the functions it defines', async () => {
      const m = stubModel()
      const { req } = await start({ sanitizer: { options: () => ({ page: 1, limit: 3, pagination: true }) } })
      await req({ url: `/things?options=${enc({ limit: 99 })}&filters=${enc({ $where: '1' })}` })
      expect(m.paginate).not.toHaveBeenCalled() // default filter sanitizer still active
      await req({ url: `/things?options=${enc({ limit: 99 })}` })
      expect(m.paginate.mock.calls[0][1].limit).toBe(3)
    })
  })

  // createScope: where the scope's `$in` keys are checked on create (new in 3.1.0)
  describe('createScope', () => {
    const TABLE_RESTAURANT = { t1: 'R1', t2: 'R2', t3: 'R9' } // R9 is not in the caller's list
    const scope = () => ({ restaurantId: { $in: ['R1', 'R2'] }, accountId: 'A' })
    const derive = (data) => ({ ...data, restaurantId: TABLE_RESTAURANT[data.tableIds?.[0]] })
    const post = (req, payload) => req({ method: 'POST', url: '/placed', payload })
    const start$ = (opts) => start({ url: '/placed', Model: Placed, scope, ...opts }, { Model: Placed })

    it('"strict" (the default) demands the key BEFORE beforeCreate, and the hook sees the forced keys', async () => {
      const m = stubModel(Placed)
      const seen = []
      const { req } = await start$({ hooks: { beforeCreate: (d) => { seen.push({ ...d }); return d } } })
      const res = await post(req, { name: 'x', tableIds: ['t1'] })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ message: 'restaurantId is required', code: 'validation_error' })
      expect(seen).toHaveLength(0)
      expect(m.create).not.toHaveBeenCalled()

      expect((await post(req, { name: 'x', restaurantId: 'R1' })).statusCode).toBe(201)
      expect(seen[0]).toMatchObject({ restaurantId: 'R1', accountId: 'A' })
    })

    it('"strict" is the same when named explicitly', async () => {
      stubModel(Placed)
      const hook = jest.fn((d) => d)
      const { req } = await start$({ createScope: 'strict', hooks: { beforeCreate: hook } })
      expect((await post(req, { name: 'x' })).statusCode).toBe(400)
      expect(hook).not.toHaveBeenCalled()
    })

    it('"after-hooks" lets beforeCreate derive the key, then forces the equality keys', async () => {
      const m = stubModel(Placed)
      const { req } = await start$({ createScope: 'after-hooks', hooks: { beforeCreate: derive } })
      const res = await post(req, { name: 'x', tableIds: ['t2'] })
      expect(res.statusCode).toBe(201)
      expect(m.create).toHaveBeenCalledWith({ name: 'x', tableIds: ['t2'], restaurantId: 'R2', accountId: 'A' })
    })

    it('the document handed to the hook has no forced keys yet (documented)', async () => {
      stubModel(Placed)
      const seen = []
      const { req } = await start$({ createScope: 'after-hooks', hooks: { beforeCreate: (d) => { seen.push({ ...d }); return derive(d) } } })
      await post(req, { name: 'x', tableIds: ['t1'], accountId: 'EVIL' })
      expect(seen[0]).toEqual({ name: 'x', tableIds: ['t1'] })
    })

    it('a key the client sent is visible to the hook and accepted when it is in the list', async () => {
      const m = stubModel(Placed)
      const seen = []
      const { req } = await start$({ createScope: 'after-hooks', hooks: { beforeCreate: (d) => { seen.push({ ...d }); return d } } })
      expect((await post(req, { name: 'x', restaurantId: 'R2' })).statusCode).toBe(201)
      expect(seen[0].restaurantId).toBe('R2')
      expect(m.create).toHaveBeenCalledWith({ name: 'x', restaurantId: 'R2', accountId: 'A' })
    })

    it('a derived key outside the list is 403 and nothing is written', async () => {
      const m = stubModel(Placed)
      const { req } = await start$({ createScope: 'after-hooks', hooks: { beforeCreate: derive } })
      const res = await post(req, { name: 'x', tableIds: ['t3'] })
      expect(res.statusCode).toBe(403)
      expect(res.json().message).toBe('Forbidden')
      expect(m.create).not.toHaveBeenCalled()
    })

    it('a hook that moves a client-sent key out of the list is 403', async () => {
      const m = stubModel(Placed)
      const { req } = await start$({ createScope: 'after-hooks', hooks: { beforeCreate: (d) => ({ ...d, restaurantId: 'R9' }) } })
      expect((await post(req, { name: 'x', restaurantId: 'R1' })).statusCode).toBe(403)
      expect(m.create).not.toHaveBeenCalled()
    })

    it('without a derived key it is 400, with or without a hook', async () => {
      const m = stubModel(Placed)
      const withHook = await start$({ createScope: 'after-hooks', hooks: { beforeCreate: (d) => d } })
      const res = await post(withHook.req, { name: 'x' })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ message: 'restaurantId is required', code: 'validation_error' })
      await withHook.app.close()

      const noHook = await start$({ createScope: 'after-hooks' })
      expect((await post(noHook.req, { name: 'x' })).statusCode).toBe(400)
      expect(m.create).not.toHaveBeenCalled()
    })

    it('a hook cannot overwrite a forced key: the scope value wins', async () => {
      const m = stubModel(Placed)
      const { req } = await start$({ createScope: 'after-hooks', hooks: { beforeCreate: (d) => ({ ...derive(d), accountId: 'EVIL' }) } })
      expect((await post(req, { name: 'x', tableIds: ['t1'] })).statusCode).toBe(201)
      expect(m.create.mock.calls[0][0].accountId).toBe('A')
    })

    it('a hook that returns nothing keeps the sanitized document (same as today)', async () => {
      const m = stubModel(Placed)
      const { req } = await start$({ createScope: 'after-hooks', hooks: { beforeCreate: () => {} } })
      expect((await post(req, { name: 'x', restaurantId: 'R1' })).statusCode).toBe(201)
      expect(m.create).toHaveBeenCalledWith({ name: 'x', restaurantId: 'R1', accountId: 'A' })
    })

    it('bulk: every item is checked before anything is written', async () => {
      const m = stubModel(Placed)
      const { req } = await start$({ createScope: 'after-hooks', hooks: { beforeCreate: derive } })
      const res = await post(req, [{ name: 'a', tableIds: ['t1'] }, { name: 'b', tableIds: ['t3'] }])
      expect(res.statusCode).toBe(403)
      expect(m.create).not.toHaveBeenCalled()
      expect(m.insertMany).not.toHaveBeenCalled()

      const ok = await post(req, [{ name: 'a', tableIds: ['t1'] }, { name: 'b', tableIds: ['t2'] }])
      expect(ok.statusCode).toBe(201)
      expect(m.create).toHaveBeenCalledWith([
        expect.objectContaining({ restaurantId: 'R1', accountId: 'A' }),
        expect.objectContaining({ restaurantId: 'R2', accountId: 'A' })
      ])
    })

    it('list, get, update and delete are untouched by the option', async () => {
      const m = stubModel(Placed)
      const { req } = await start$({ createScope: 'after-hooks', hooks: { beforeCreate: derive } })
      await req({ url: '/placed' })
      await req({ url: `/placed/${ID}` })
      await req({ method: 'PUT', url: `/placed/${ID}`, payload: { name: 'y', restaurantId: 'R2', accountId: 'EVIL' } })
      await req({ method: 'DELETE', url: `/placed/${ID}` })
      const filter = { restaurantId: { $in: ['R1', 'R2'] }, accountId: 'A' }
      expect(m.paginate.mock.calls[0][0]).toEqual(filter)
      expect(m.findOne.mock.calls[0][0]).toEqual({ _id: ID, ...filter })
      expect(m.update.mock.calls[0][0]).toEqual({ _id: ID, ...filter })
      expect(m.update.mock.calls[0][1]).toEqual({ name: 'y' }) // scope keys are still dropped from updates
      expect(m.remove.mock.calls[0][0]).toEqual({ _id: ID, ...filter })
    })

    it.each([['later'], [true], [null], [1]])('refuses an invalid value (%p) when registering', async (value) => {
      await expect(serve(Fastify, { url: '/placed', Model: Placed, createScope: value })).rejects.toThrow(/createScope/)
    })
  })
})

describe('package contract', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

  it('exposes the entry point and the sanitizer subpath, and ships what it lists', () => {
    expect(pkg.exports['.']).toBe('./crudify.js')
    expect(pkg.exports['./sanitizer']).toBe('./sanitizer.js')
    for (const file of pkg.files.filter(f => f.endsWith('.js'))) expect(existsSync(new URL(`../../${file}`, import.meta.url))).toBe(true)
    expect(pkg.version).toBe('2.0.0')
    expect(pkg.engines.node).toBe('>=20')
  })

  it('has no runtime dependencies (fastify, mongoose and paginate are peers)', () => {
    expect(pkg.dependencies).toBeUndefined()
    expect(Object.keys(pkg.peerDependencies)).toEqual(['fastify', 'mongoose', 'mongoose-paginate-v2'])
  })
})
