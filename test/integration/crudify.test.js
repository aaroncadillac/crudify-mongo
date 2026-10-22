import { describe, it, expect, beforeAll, beforeEach, afterAll } from '@jest/globals'
import mongoose from 'mongoose'
import paginate from 'mongoose-paginate-v2'
import { Crudify, CrudifyError } from '../../crudify.js'
import { FASTIFIES } from '../helpers/fastifies.js'
import { boot, enc } from '../helpers/client.js'

// Real Mongo (in-memory mongod). Proves the headline claims end to end:
// tenant isolation, hooks on every verb, no leaks, bounded queries (C1-C15, C18-C20).

const counters = { save: 0, update: 0, remove: 0 }
const schema = new mongoose.Schema({
  name: { type: String, required: true },
  age: Number,
  accountId: String,
  sku: { type: String, unique: true, sparse: true },
  email: String,
  status: String,
  secret: { type: String, select: false }
}, { timestamps: true })
schema.plugin(paginate)
schema.pre('save', function () { counters.save++ })
schema.pre('findOneAndUpdate', function () { counters.update++ })
schema.pre('findOneAndDelete', function () { counters.remove++ })
const Item = mongoose.model('Item', schema)


// Orders carry no restaurantId from the client: it is derived from their tables (createScope: 'after-hooks').
const tableSchema = new mongoose.Schema({ restaurantId: String })
const orderSchema = new mongoose.Schema({
  name: String,
  tableIds: [String],
  restaurantId: String,
  accountId: String
}, { timestamps: true })
orderSchema.plugin(paginate)
orderSchema.pre('save', function () { counters.save++ })
const Table = mongoose.model('TableLookup', tableSchema)
const Order = mongoose.model('OrderDerived', orderSchema)

const tenant = (id) => ({ 'x-tenant': id })
const base = {
  url: '/items',
  Model: Item,
  authorize: (req) => { if (!req.headers['x-tenant']) throw new CrudifyError(401, 'tenant required') },
  scope: (req) => ({ accountId: req.headers['x-tenant'] })
}

beforeAll(async () => {
  await mongoose.connect(global.__MONGO_URI__, { dbName: global.__MONGO_DB_NAME__ })
  await Item.init()
  await Order.init()
})
afterAll(async () => { await mongoose.disconnect() })
beforeEach(async () => {
  await Item.deleteMany({})
  await Promise.all([Table.deleteMany({}), Order.deleteMany({})])
  Object.assign(counters, { save: 0, update: 0, remove: 0 })
})

describe.each(FASTIFIES)('%s · Crudify (real Mongo)', (_, Fastify) => {
  const servers = []
  const serve = async (opts = {}, before) => {
    const s = await boot(Fastify, async (app) => { before?.(app); app.register(Crudify, { ...base, ...opts }) })
    servers.push(s)
    return s
  }
  afterAll(async () => { await Promise.all(servers.map(s => s.close())) })

  describe('CRUD contract kept from 1.x', () => {
    it('creates, reads, updates and deletes', async () => {
      const { req } = await serve()
      const h = tenant('A')
      const created = await req({ method: 'POST', url: '/items', payload: { name: 'John', age: 30 }, headers: h })
      expect(created.statusCode).toBe(201)
      const { _id } = created.json()
      expect(_id).toBeDefined()
      expect((await req({ url: `/items/${_id}`, headers: h })).json()).toMatchObject({ _id, name: 'John', age: 30, accountId: 'A' })
      const updated = await req({ method: 'PUT', url: `/items/${_id}`, payload: { age: 31 }, headers: h })
      expect(updated.json()).toMatchObject({ _id, age: 31 }) // returns the NEW document
      expect((await req({ method: 'DELETE', url: `/items/${_id}`, headers: h })).statusCode).toBe(200)
      const gone = await req({ url: `/items/${_id}`, headers: h })
      expect(gone.statusCode).toBe(404)
      expect(gone.json()).toEqual({ status: 404, error: 'Not Found', message: `ID: ${_id} not found` })
    })

    it('lists with the paginate shape', async () => {
      await Item.create([{ name: 'a', accountId: 'A' }, { name: 'b', accountId: 'A' }])
      const { req } = await serve()
      const body = (await req({ url: '/items', headers: tenant('A') })).json()
      expect(Object.keys(body).sort()).toEqual(['docs', 'hasNextPage', 'hasPrevPage', 'limit', 'nextPage', 'page', 'pagingCounter', 'prevPage', 'totalDocs', 'totalPages'])
      expect(body.docs).toHaveLength(2)
    })

    it('mongoose hooks run on update and delete too', async () => {
      const item = await Item.create({ name: 'a', accountId: 'A' })
      Object.assign(counters, { save: 0 })
      const { req } = await serve()
      await req({ method: 'PUT', url: `/items/${item._id}`, payload: { name: 'b' }, headers: tenant('A') })
      await req({ method: 'DELETE', url: `/items/${item._id}`, headers: tenant('A') })
      expect(counters).toMatchObject({ update: 1, remove: 1 })
    })
  })

  describe('tenant isolation (C4)', () => {
    let a1, b1
    beforeEach(async () => {
      ;[a1] = await Item.create([{ name: 'a1', accountId: 'A' }, { name: 'a2', accountId: 'A' }])
      b1 = await Item.create({ name: 'b1', accountId: 'B' })
    })

    it('lists only the tenant documents, even with hostile filters', async () => {
      const { req } = await serve()
      const names = async (filters) => (await req({ url: `/items?filters=${enc(filters)}`, headers: tenant('A') })).json().docs.map(d => d.name).sort()
      expect(await names({})).toEqual(['a1', 'a2'])
      expect(await names({ accountId: 'B' })).toEqual([])
      expect(await names({ $or: [{ accountId: 'B' }, { name: 'b1' }] })).toEqual([])
      expect(await names({ accountId: { $ne: 'A' } })).toEqual([])
    })

    it('another tenant id is a plain 404 for get, update and delete, and nothing changes', async () => {
      const { req } = await serve()
      const h = tenant('A')
      expect((await req({ url: `/items/${b1._id}`, headers: h })).statusCode).toBe(404)
      expect((await req({ method: 'PUT', url: `/items/${b1._id}`, payload: { name: 'hacked' }, headers: h })).statusCode).toBe(404)
      expect((await req({ method: 'DELETE', url: `/items/${b1._id}`, headers: h })).statusCode).toBe(404)
      expect(await Item.findById(b1._id)).toMatchObject({ name: 'b1', accountId: 'B' })
    })

    it('forces the tenant on create and never lets an update move a document (C5)', async () => {
      const { req } = await serve()
      const h = tenant('A')
      const created = await req({ method: 'POST', url: '/items', payload: { name: 'mine', accountId: 'B' }, headers: h })
      expect(created.json().accountId).toBe('A')
      await req({ method: 'PUT', url: `/items/${a1._id}`, payload: { accountId: 'B', name: 'renamed' }, headers: h })
      expect(await Item.findById(a1._id)).toMatchObject({ name: 'renamed', accountId: 'A' })
    })

    it('authorize runs before anything else', async () => {
      const { req } = await serve()
      const res = await req({ url: '/items' })
      expect(res.statusCode).toBe(401)
      expect(res.json().message).toBe('tenant required')
    })

    it('a multi-value scope ({ $in }) restricts and validates the client value', async () => {
      const { req } = await serve({ scope: () => ({ accountId: { $in: ['A', 'B'] } }) })
      expect((await req({ url: '/items', headers: tenant('x') })).json().docs).toHaveLength(3)
      expect((await req({ method: 'POST', url: '/items', payload: { name: 'n', accountId: 'C' }, headers: tenant('x') })).statusCode).toBe(403)
      expect((await req({ method: 'POST', url: '/items', payload: { name: 'n' }, headers: tenant('x') })).statusCode).toBe(400)
      expect((await req({ method: 'POST', url: '/items', payload: { name: 'n', accountId: 'B' }, headers: tenant('x') })).statusCode).toBe(201)
    })
  })

  describe('writes: bulk, mass assignment, errors (C5, C6, C7, C8, C14)', () => {
    const h = tenant('A')

    it('bulk create runs the save hooks for every item (C6)', async () => {
      const { req } = await serve()
      const res = await req({ method: 'POST', url: '/items', payload: [{ name: 'a' }, { name: 'b' }, { name: 'c' }], headers: h })
      expect(res.statusCode).toBe(201)
      expect(res.json()).toEqual({ message: 'All documents created successfully' })
      expect(counters.save).toBe(3)
      expect(await Item.countDocuments({ accountId: 'A' })).toBe(3)
    })

    it('one invalid item in a bulk inserts nothing', async () => {
      const { req } = await serve()
      const res = await req({ method: 'POST', url: '/items', payload: [{ name: 'ok' }, { age: 1 }], headers: h })
      expect(res.statusCode).toBe(400)
      expect(res.json().message).toBe('Fields: [name] are required and cannot be empty')
      expect(await Item.countDocuments({})).toBe(0)
    })

    it('insertMany is opt-in and then skips the save hooks (documented)', async () => {
      const { req } = await serve({ bulk: { insertMany: true } })
      await req({ method: 'POST', url: '/items', payload: [{ name: 'a' }, { name: 'b' }], headers: h })
      expect(counters.save).toBe(0)
      expect(await Item.countDocuments({})).toBe(2)
    })

    it('rejects oversized bulks (C14)', async () => {
      const { req } = await serve({ bulk: { max: 3 } })
      const res = await req({ method: 'POST', url: '/items', payload: Array.from({ length: 4 }, (_, i) => ({ name: `n${i}` })), headers: h })
      expect(res.statusCode).toBe(413)
      expect(await Item.countDocuments({})).toBe(0)
    })

    it('ignores _id, timestamps and __v sent by the client on create and update', async () => {
      const { req } = await serve()
      const other = new mongoose.Types.ObjectId().toString()
      const created = (await req({ method: 'POST', url: '/items', payload: { _id: other, name: 'n', createdAt: '2000-01-01', __v: 7 }, headers: h })).json()
      expect(created._id).not.toBe(other)
      expect(new Date(created.createdAt).getFullYear()).toBeGreaterThan(2000)
      await req({ method: 'PUT', url: `/items/${created._id}`, payload: { _id: other, createdAt: '2000-01-01', __v: 9, name: 'n2' }, headers: h })
      const stored = await Item.findById(created._id)
      expect(stored.name).toBe('n2')
      expect(stored.__v).toBe(0)
      expect(stored.createdAt.getFullYear()).toBeGreaterThan(2000)
    })

    it('refuses update operators and keeps $set / $unset working', async () => {
      const item = await Item.create({ name: 'a', accountId: 'A', status: 'x' })
      const { req } = await serve()
      expect((await req({ method: 'PUT', url: `/items/${item._id}`, payload: { $rename: { name: 'status' } }, headers: h })).statusCode).toBe(400)
      expect((await req({ method: 'PUT', url: `/items/${item._id}`, payload: { $unset: { status: '' } }, headers: h })).statusCode).toBe(200)
      expect((await Item.findById(item._id)).status).toBeUndefined()
    })

    it('answers 409 to a real duplicate key without leaking collection, index or value (C7)', async () => {
      const { req } = await serve()
      await req({ method: 'POST', url: '/items', payload: { name: 'a', sku: 'SKU-SECRET-1' }, headers: h })
      const dup = await req({ method: 'POST', url: '/items', payload: { name: 'b', sku: 'SKU-SECRET-1' }, headers: h })
      expect(dup.statusCode).toBe(409)
      expect(dup.json()).toEqual({ status: 409, error: 'Conflict', message: 'Duplicate key', code: 'duplicate_key' })
      expect(dup.body).not.toMatch(/SKU-SECRET|items|sku_1|E11000/)
    })

    it('maps validation and cast errors to 400 with one body shape (C8)', async () => {
      const item = await Item.create({ name: 'a', accountId: 'A' })
      const { req } = await serve()
      const required = await req({ method: 'POST', url: '/items', payload: { age: 3 }, headers: h })
      expect(required.json()).toMatchObject({ status: 400, error: 'Bad Request', message: 'Fields: [name] are required and cannot be empty', code: 'validation_error' })
      const cast = await req({ method: 'PUT', url: `/items/${item._id}`, payload: { age: 'abc' }, headers: h })
      expect(cast.statusCode).toBe(400)
      expect(cast.json()).toMatchObject({ code: 'validation_error', message: 'Invalid value for "age"' })
    })

    it('never answers 500 for bad input', async () => {
      const { req } = await serve()
      const bad = [
        { url: '/items/zzz' }, { url: `/items?filters=${encodeURIComponent('{')}` }, { url: '/items?options=%5B%5D' },
        { url: `/items?filters=${enc({ a: { $in: 'x' } })}` }, { url: '/items?filters=a&filters=b' }
      ]
      for (const request of bad) expect((await req({ ...request, headers: h })).statusCode).toBeLessThan(500)
    })
  })

  describe('bounded queries (C1, C2, C3, C20)', () => {
    const h = tenant('A')
    beforeEach(async () => {
      await Item.create(Array.from({ length: 120 }, (_, i) => ({ name: `item-${i}`, accountId: 'A' })))
    })

    it('defaults to 50 per page and caps at 100; pagination:false is ignored (C3)', async () => {
      const { req } = await serve()
      const first = (await req({ url: '/items', headers: h })).json()
      expect(first.docs).toHaveLength(50)
      expect(first.totalDocs).toBe(120)
      const big = (await req({ url: `/items?options=${enc({ limit: 5000, pagination: false })}`, headers: h })).json()
      expect(big.docs).toHaveLength(100)
      expect(big.limit).toBe(100)
    })

    it('pages and sorts', async () => {
      const { req } = await serve()
      const page = (await req({ url: `/items?options=${enc({ page: 3, limit: 50, sort: '-name' })}`, headers: h })).json()
      expect(page.docs).toHaveLength(20)
      expect(page.docs[0].name > page.docs[1].name).toBe(true)
    })

    it('ignores populate / select / lean from the client', async () => {
      await Item.updateMany({}, { secret: 's3cret' })
      const { req } = await serve()
      const res = await req({ url: `/items?options=${enc({ select: '+secret', populate: 'x', lean: true, limit: 1 })}`, headers: h })
      expect(res.statusCode).toBe(200)
      expect(res.json().docs[0]).not.toHaveProperty('secret')
    })

    it('searches "/text/" as an escaped literal (C2)', async () => {
      await Item.create([{ name: 'a.b', accountId: 'A' }, { name: 'axb', accountId: 'A' }])
      const { req } = await serve()
      const found = (await req({ url: `/items?filters=${enc({ name: '/a.b/' })}`, headers: h })).json().docs.map(d => d.name)
      expect(found).toEqual(['a.b'])
      const prefix = await serve({ query: { search: 'prefix' } })
      const hits = (await prefix.req({ url: `/items?filters=${enc({ name: '/item-1/' })}&options=${enc({ limit: 100 })}`, headers: h })).json()
      expect(hits.totalDocs).toBe(31) // item-1, item-10..19 and item-100..119 share the prefix
    })

    it('a catastrophic "regex" is just text and answers fast (ReDoS)', async () => {
      await Item.create({ name: 'a'.repeat(30) + '!', accountId: 'A' })
      const { req } = await serve()
      const started = performance.now()
      const res = await req({ url: `/items?filters=${enc({ name: '/(a+)+$/' })}`, headers: h })
      expect(performance.now() - started).toBeLessThan(200)
      expect(res.json().docs).toHaveLength(0)
    })

    it('rejects $where / $regex / $expr', async () => {
      const { req } = await serve()
      for (const filters of [{ $where: 'sleep(1000)' }, { name: { $regex: '.*' } }, { $expr: { $eq: [1, 1] } }]) {
        expect((await req({ url: `/items?filters=${enc(filters)}`, headers: h })).statusCode).toBe(400)
      }
    })

    it('does not let a select:false field be used as a search oracle (C20)', async () => {
      await Item.updateMany({}, { secret: 'topsecret' })
      const { req } = await serve()
      expect((await req({ url: `/items?filters=${enc({ secret: { $gt: 'a' } })}`, headers: h })).statusCode).toBe(400)
      expect((await req({ url: `/items?options=${enc({ sort: 'secret' })}`, headers: h })).statusCode).toBe(400)
    })

    it('honours filterable and populate allowlists', async () => {
      const { req } = await serve({ query: { filterable: ['name'] } })
      expect((await req({ url: `/items?filters=${enc({ age: 1 })}`, headers: h })).statusCode).toBe(400)
      expect((await req({ url: `/items?filters=${enc({ name: 'item-1' })}`, headers: h })).statusCode).toBe(200)
    })
  })

  describe('verbs, hooks, serialize, lean (C9, C10)', () => {
    const h = tenant('A')

    it('methods restricts the verbs (C10)', async () => {
      const item = await Item.create({ name: 'a', accountId: 'A' })
      const { req } = await serve({ methods: ['list', 'get'] })
      expect((await req({ url: `/items/${item._id}`, headers: h })).statusCode).toBe(200)
      expect((await req({ method: 'POST', url: '/items', payload: { name: 'x' }, headers: h })).statusCode).toBe(404)
      expect((await req({ method: 'PUT', url: `/items/${item._id}`, payload: { name: 'x' }, headers: h })).statusCode).toBe(404)
      expect((await req({ method: 'DELETE', url: `/items/${item._id}`, headers: h })).statusCode).toBe(404)
    })

    it('beforeDelete can veto; the document stays', async () => {
      const item = await Item.create({ name: 'a', accountId: 'A', status: 'paid' })
      const { req } = await serve({ hooks: { beforeDelete: (doc) => { if (doc.status === 'paid') throw new CrudifyError(409, 'paid items cannot be deleted', { code: 'paid' }) } } })
      const res = await req({ method: 'DELETE', url: `/items/${item._id}`, headers: h })
      expect(res.statusCode).toBe(409)
      expect(res.json().code).toBe('paid')
      expect(await Item.exists({ _id: item._id })).toBeTruthy()
    })

    it('serialize hides fields in every response', async () => {
      const item = await Item.create({ name: 'a', email: 'a@x.com', accountId: 'A' })
      const { req } = await serve({ serialize: (doc) => { const { email, ...rest } = doc.toObject({ flattenObjectIds: true }); return rest } })
      expect((await req({ url: `/items/${item._id}`, headers: h })).json()).not.toHaveProperty('email')
      expect((await req({ url: '/items', headers: h })).json().docs[0]).not.toHaveProperty('email')
    })

    it('lean:true returns plain objects with the same JSON shape', async () => {
      const item = await Item.create({ name: 'a', accountId: 'A' })
      const { req } = await serve({ lean: true })
      expect((await req({ url: `/items/${item._id}`, headers: h })).json()).toMatchObject({ name: 'a', accountId: 'A' })
      expect((await req({ url: '/items', headers: h })).json().docs).toHaveLength(1)
      expect((await req({ method: 'PUT', url: `/items/${item._id}`, payload: { name: 'b' }, headers: h })).json().name).toBe('b')
    })

    it('registers under a prefix', async () => {
      const item = await Item.create({ name: 'a', accountId: 'A' })
      const { req } = await serve({ prefix: '/v2' })
      expect((await req({ url: `/v2/items/${item._id}`, headers: h })).statusCode).toBe(200)
    })
  })

  describe('custom routes and actions share scope + authorize (C11, extensibility)', () => {
    it('POST /:id/close mutates only the caller tenant and honours authorize by action', async () => {
      const [mine] = await Item.create([{ name: 'a', accountId: 'A' }, { name: 'b', accountId: 'B' }])
      const theirs = await Item.findOne({ accountId: 'B' })
      const { req } = await serve({
        authorize: (r, action) => { if (action === 'close' && r.headers['x-role'] !== 'admin') throw new CrudifyError(403, 'admins only') },
        actions: { close: { handler: async (r, reply, ctx) => { const doc = r.crudify.doc; doc.status = 'closed'; await doc.save(); return ctx.serialize(doc, r) } } }
      })
      const admin = { ...tenant('A'), 'x-role': 'admin' }
      expect((await req({ method: 'POST', url: `/items/${mine._id}/close`, headers: tenant('A') })).statusCode).toBe(403)
      expect((await req({ method: 'POST', url: `/items/${theirs._id}/close`, headers: admin })).statusCode).toBe(404)
      const ok = await req({ method: 'POST', url: `/items/${mine._id}/close`, headers: admin })
      expect(ok.json().status).toBe('closed')
      expect((await Item.findById(theirs._id)).status).toBeUndefined()
    })

    it('routes(api, ctx) can build on ctx.list and ctx.where', async () => {
      await Item.create([{ name: 'a', accountId: 'A' }, { name: 'b', accountId: 'B' }])
      const { req } = await serve({
        routes: (api) => api.get('/count', { action: 'list' }, async (r, reply, ctx) => ({ n: await ctx.Model.countDocuments(await ctx.where(r, 'list')) }))
      })
      expect((await req({ url: '/items/count', headers: tenant('A') })).json()).toEqual({ n: 1 })
    })

    it('handlers.<verb> replaces one verb and keeps the guarantees', async () => {
      await Item.create([{ name: 'a', accountId: 'A' }, { name: 'b', accountId: 'B' }])
      const { req } = await serve({ handlers: { list: async (r, reply, ctx) => ({ custom: (await ctx.list(r)).totalDocs }) } })
      expect((await req({ url: '/items', headers: tenant('A') })).json()).toEqual({ custom: 1 })
      expect((await req({ url: '/items' })).statusCode).toBe(401)
    })

    it('additionalRoutes was removed: registration fails with a pointer to routes/actions', async () => {
      await expect(serve({ additionalRoutes: [{ method: 'GET', url: '/legacy', handler: async () => ({}) }] })).rejects.toThrow(/additionalRoutes.*removed/)
    })
  })

  describe('JSONSchema (C13, C18, C19)', () => {
    const JSONSchema = {
      type: 'object',
      required: ['name'],
      properties: {
        _id: { type: 'string' }, name: { type: 'string' }, age: { type: 'number' }, accountId: { type: 'string' },
        createdAt: { type: 'string' }, updatedAt: { type: 'string' }, __v: { type: 'number' }
      }
    }
    const h = tenant('A')

    it('serializes real documents with the paginate shape and string ids', async () => {
      await Item.create({ name: 'a', age: 3, accountId: 'A' })
      const { req } = await serve({ JSONSchema })
      const body = (await req({ url: '/items', headers: h })).json()
      expect(body.totalDocs).toBe(1)
      expect(body.docs[0]).toMatchObject({ name: 'a', age: 3, accountId: 'A' })
      expect(typeof body.docs[0]._id).toBe('string')
      expect(typeof body.docs[0].createdAt).toBe('string')
    })

    it('validates the body for one object and for a bulk array', async () => {
      const { req } = await serve({ JSONSchema })
      expect((await req({ method: 'POST', url: '/items', payload: { name: 'a' }, headers: h })).statusCode).toBe(201)
      expect((await req({ method: 'POST', url: '/items', payload: [{ name: 'b' }, { name: 'c' }], headers: h })).statusCode).toBe(201)
      expect((await req({ method: 'POST', url: '/items', payload: { age: 1 }, headers: h })).statusCode).toBe(400)
      expect((await req({ method: 'POST', url: '/items', payload: [{ name: 'd' }, { age: 1 }], headers: h })).statusCode).toBe(400)
      expect(await Item.countDocuments({})).toBe(3)
    })
  })

  describe('createScope: "after-hooks" (derived tenant key)', () => {
    const caller = (restaurants, account = 'A') => ({ 'x-tenant': account, 'x-restaurants': restaurants })
    const h = caller('R1,R2')
    const orders = {
      url: '/orders',
      Model: Order,
      createScope: 'after-hooks',
      authorize: () => {},
      scope: (req) => ({ accountId: req.headers['x-tenant'], restaurantId: { $in: req.headers['x-restaurants'].split(',') } }),
      hooks: {
        beforeCreate: async (data) => {
          const tables = await Table.find({ _id: { $in: data.tableIds ?? [] } }).lean()
          return { ...data, restaurantId: tables[0]?.restaurantId }
        }
      }
    }
    let t1, t2, t9
    beforeEach(async () => {
      ;[t1, t2, t9] = (await Table.create([{ restaurantId: 'R1' }, { restaurantId: 'R2' }, { restaurantId: 'R9' }])).map(t => String(t._id))
    })

    it('derives the key in the hook, validates the final document, and the save hooks run', async () => {
      const { req } = await serve(orders)
      const res = await req({ method: 'POST', url: '/orders', payload: { name: 'o', tableIds: [t1], accountId: 'EVIL' }, headers: h })
      expect(res.statusCode).toBe(201)
      expect(res.json()).toMatchObject({ restaurantId: 'R1', accountId: 'A' })
      expect(counters.save).toBe(1)
      expect(await Order.countDocuments({ restaurantId: 'R1', accountId: 'A' })).toBe(1)
    })

    it('a table of a restaurant outside the caller\'s list is 403 and nothing is stored', async () => {
      const { req } = await serve(orders)
      const res = await req({ method: 'POST', url: '/orders', payload: { name: 'o', tableIds: [t9] }, headers: h })
      expect(res.statusCode).toBe(403)
      expect(await Order.countDocuments({})).toBe(0)
    })

    it('a hook that derives nothing is 400', async () => {
      const { req } = await serve(orders)
      const res = await req({ method: 'POST', url: '/orders', payload: { name: 'o', tableIds: [] }, headers: h })
      expect(res.statusCode).toBe(400)
      expect(res.json().message).toBe('restaurantId is required')
    })

    it('a hook cannot overwrite a forced key: the scope value is stored', async () => {
      const { req } = await serve({ ...orders, hooks: { beforeCreate: async (d) => ({ ...await orders.hooks.beforeCreate(d), accountId: 'EVIL' }) } })
      const res = await req({ method: 'POST', url: '/orders', payload: { name: 'o', tableIds: [t2] }, headers: h })
      expect(res.json()).toMatchObject({ restaurantId: 'R2', accountId: 'A' })
    })

    it('bulk: one item outside the list inserts nothing', async () => {
      const { req } = await serve(orders)
      const bad = await req({ method: 'POST', url: '/orders', payload: [{ name: 'a', tableIds: [t1] }, { name: 'b', tableIds: [t9] }], headers: h })
      expect(bad.statusCode).toBe(403)
      expect(await Order.countDocuments({})).toBe(0)
      const ok = await req({ method: 'POST', url: '/orders', payload: [{ name: 'a', tableIds: [t1] }, { name: 'b', tableIds: [t2] }], headers: h })
      expect(ok.statusCode).toBe(201)
      expect(await Order.countDocuments({})).toBe(2)
    })

    it('the stored document stays isolated: other restaurants / tenants get a plain 404', async () => {
      const { req } = await serve(orders)
      const { _id } = (await req({ method: 'POST', url: '/orders', payload: { name: 'o', tableIds: [t1] }, headers: h })).json()
      expect((await req({ url: `/orders/${_id}`, headers: caller('R1') })).statusCode).toBe(200)
      expect((await req({ url: `/orders/${_id}`, headers: caller('R2') })).statusCode).toBe(404)
      expect((await req({ url: `/orders/${_id}`, headers: caller('R1', 'B') })).statusCode).toBe(404)
      const moved = await req({ method: 'PUT', url: `/orders/${_id}`, payload: { name: 'p', restaurantId: 'R2', accountId: 'B' }, headers: caller('R1') })
      expect(moved.json()).toMatchObject({ name: 'p', restaurantId: 'R1', accountId: 'A' })
    })

    it('the default "strict" mode still demands the key before the hook runs', async () => {
      const { req } = await serve({ ...orders, createScope: undefined })
      const res = await req({ method: 'POST', url: '/orders', payload: { name: 'o', tableIds: [t1] }, headers: h })
      expect(res.statusCode).toBe(400)
      expect(res.json().message).toBe('restaurantId is required')
      expect(await Order.countDocuments({})).toBe(0)
    })
  })
})
