import { STATUS_CODES } from 'node:http'
import { CrudifyError, createSanitizer, isPlainObject, parseJson } from './sanitizer.js'

export * from './sanitizer.js'

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/
const VERBS = ['list', 'get', 'create', 'update', 'delete']
const ROUTES = { list: ['GET', ''], get: ['GET', '/:id'], create: ['POST', ''], update: ['PUT', '/:id'], delete: ['DELETE', '/:id'] }
const DEFAULT_ACTION = { GET: 'get', DELETE: 'delete' } // any other method defaults to 'update'
const ALWAYS_READONLY = ['_id', '__v', 'createdAt', 'updatedAt']
const EMPTY = Object.freeze({})
const forbidden = () => new CrudifyError(403, 'Forbidden')
const notFound = (id) => new CrudifyError(404, `ID: ${id} not found`)

// ── Errors ───────────────────────────────────────────────────────────────
// Clients never see Mongo/hook internals: 4xx messages come from CrudifyError,
// Fastify validation or the field names of a ValidationError; the rest is 500.
const errorBody = (status, message, code, details) =>
  ({ status, error: STATUS_CODES[status], message, ...(code && { code }), ...(details && { details }) })

const isDuplicateKeyError = (err) => !!err && (err.code === 11000 || err.cause?.code === 11000 ||
  (Array.isArray(err.writeErrors) && err.writeErrors.some(w => w?.code === 11000 || w?.err?.code === 11000)))

const duplicateKeyFields = (err) => {
  const src = err?.cause?.code === 11000 ? err.cause : err
  const pattern = src?.keyPattern ?? src?.keyValue
  if (pattern && typeof pattern === 'object') return Object.keys(pattern)
  const index = /index:\s*(\S+)/.exec(String(src?.message))?.[1]
  return index ? [index.replace(/_-?1$/, '')] : []
}

// Pure: error -> { status, body, level?, meta? } (`level` is the log level to use).
const toErrorResponse = (err) => {
  const status = err?.statusCode
  if (err instanceof CrudifyError || (status >= 400 && status < 500)) {
    return { status, body: errorBody(status, err.message, typeof err.code === 'string' ? err.code : undefined, err.details) }
  }
  if (isDuplicateKeyError(err)) {
    return { status: 409, body: errorBody(409, 'Duplicate key', 'duplicate_key'), level: 'warn', meta: { fields: duplicateKeyFields(err) } }
  }
  switch (err?.name) {
    case 'ValidationError': {
      const fields = Object.keys(err.errors ?? {})
      const required = fields.filter(f => err.errors[f].kind === 'required')
      return required.length
        ? { status: 400, body: errorBody(400, `Fields: [${required.join(', ')}] are required and cannot be empty`, 'validation_error') }
        : { status: 400, body: errorBody(400, `Invalid fields: [${fields.join(', ')}]`, 'validation_error', { fields }) }
    }
    case 'CastError':
    case 'StrictModeError':
      return { status: 400, body: errorBody(400, `Invalid value for "${err.path ?? 'field'}"`, 'validation_error') }
    case 'DocumentNotFoundError': return { status: 404, body: errorBody(404, 'Not found') }
    case 'VersionError': return { status: 409, body: errorBody(409, 'Version conflict', 'version_conflict') }
  }
  return { status: 500, body: errorBody(500, 'Internal error'), level: 'error' }
}

// ── Scope: the server-side filter ANDed with every read and write ────────────
const composeFilter = (base, scope) => {
  for (const key in scope) if (Object.hasOwn(base, key)) return { $and: [base, scope] }
  return Object.assign(base, scope) // `base` is always a fresh object, `scope` is never mutated
}

// Root-level scope keys can't be rewritten by the client: equality values are
// forced into new documents, `{ $in: [...] }` values must contain the client's.
const writeRules = (scope) => {
  const rules = { keys: [], forced: {}, inLists: {} }
  for (const key in scope) {
    if (key[0] === '$') continue
    const v = scope[key]
    rules.keys.push(key)
    if (v === null || typeof v !== 'object' || v instanceof Date || v._bsontype) rules.forced[key] = v
    else if (Array.isArray(v.$in)) rules.inLists[key] = v.$in
  }
  return rules
}

// ── Route schemas (only when `JSONSchema` is given), built once ──────────────
const PAGE_PROPS = {
  totalDocs: { type: 'integer' }, limit: { type: 'integer' }, totalPages: { type: 'integer' }, page: { type: 'integer' },
  pagingCounter: { type: 'integer' }, hasPrevPage: { type: 'boolean' }, hasNextPage: { type: 'boolean' },
  prevPage: { type: ['integer', 'null'] }, nextPage: { type: ['integer', 'null'] }
}
const stripRef = (n) => Array.isArray(n) ? n.map(stripRef) : n && typeof n === 'object'
  ? Object.fromEntries(Object.entries(n).filter(([k]) => k !== 'x-ref').map(([k, v]) => [k, stripRef(v)])) : n
const omitRequired = ({ required, ...rest }) => rest

const buildSchemas = ({ JSONSchema, readonly, schema: user = {}, bulk }) => {
  const schemas = { list: { querystring: { type: 'object', properties: { filters: { type: 'string' }, options: { type: 'string' } } } }, get: {}, create: {}, update: {}, delete: {} }
  if (JSONSchema) {
    const doc = stripRef(JSONSchema)
    // `required` is dropped on responses: `select`/`serialize` may hide fields
    const out = omitRequired(doc)
    const properties = Object.fromEntries(Object.entries(doc.properties ?? {}).filter(([k]) => !readonly.has(k)))
    const required = doc.required?.filter(k => !readonly.has(k))
    const body = { type: doc.type ?? 'object', properties, ...(required?.length && { required }) }
    schemas.list.response = { 200: { type: 'object', properties: { docs: { type: 'array', items: out }, ...PAGE_PROPS } } }
    schemas.get.response = schemas.delete.response = { 200: out }
    schemas.update = { body: omitRequired(body), response: { 200: out } }
    schemas.create = {
      body: bulk ? { anyOf: [body, { type: 'array', minItems: 1, items: body }] } : body,
      response: { 201: bulk ? { ...out, properties: { ...out.properties, message: { type: 'string' } } } : out }
    }
  }
  for (const verb of VERBS) {
    const u = user[verb]
    if (u) schemas[verb] = { ...schemas[verb], ...u, ...((schemas[verb].response || u.response) && { response: { ...schemas[verb].response, ...u.response } }) }
  }
  return schemas
}

// ── Options: validate and precompute everything once, at registration ────────
const timestampNames = (schema) => {
  const t = schema.options.timestamps
  const name = (v, d) => typeof v === 'string' ? v : v === false ? null : d
  return t ? [name(t.createdAt, 'createdAt'), name(t.updatedAt, 'updatedAt')].filter(Boolean) : []
}

const normalizeOptions = (opts, log) => {
  const { url, Model, strict = false, scope, authorize, serialize, mapError } = opts
  if (typeof url !== 'string') throw new TypeError('Crudify: `url` is required')
  if (typeof Model?.findOne !== 'function') throw new TypeError('Crudify: `Model` must be a Mongoose model')
  const methods = opts.methods ?? VERBS
  const unknown = methods.find(m => !VERBS.includes(m))
  if (unknown) throw new TypeError(`Crudify: unknown method "${unknown}"`)
  if (methods.includes('list') && typeof Model.paginate !== 'function') throw new TypeError('Crudify: `list` needs mongoose-paginate-v2 (Model.paginate)')
  if (opts.additionalRoutes !== undefined) throw new TypeError('Crudify: `additionalRoutes` was removed, use `routes(api, ctx)` or `actions`')
  const createScope = opts.createScope === undefined ? 'strict' : opts.createScope
  if (createScope !== 'strict' && createScope !== 'after-hooks') throw new TypeError('Crudify: `createScope` must be "strict" or "after-hooks"')
  const hooks = opts.hooks ?? {}
  for (const [name, fn] of Object.entries({ scope, authorize, serialize, mapError, ...hooks })) {
    if (fn !== undefined && fn !== false && typeof fn !== 'function') throw new TypeError(`Crudify: \`${name}\` must be a function`)
  }
  if (strict && (scope === undefined || opts.sanitizer === false)) throw new TypeError('Crudify (strict): `scope` is required and `sanitizer` cannot be disabled')
  if (scope === undefined) log.warn(`Crudify ${url}: no \`scope\`, every request sees every document (use \`scope: false\` to silence)`)
  if (opts.sanitizer === false) log.warn(`Crudify ${url}: sanitizer disabled, client filters, options and bodies reach Mongo as-is`)

  const hidden = new Set(opts.fields?.hidden)
  Model.schema.eachPath((path, type) => { if (type.options?.select === false) hidden.add(path) })
  const readonly = [...ALWAYS_READONLY, ...timestampNames(Model.schema), ...(opts.fields?.readonly ?? [])]
  const bulk = opts.bulk === false ? false : { max: 100, insertMany: false, ...opts.bulk }
  const compiled = createSanitizer({ ...opts.query, writable: opts.fields?.writable, readonly, hidden: [...hidden] })
  const san = opts.sanitizer === false
    ? { // 1.x behaviour: nothing is narrowed
        filter: (f) => { for (const k in f) if (typeof f[k] === 'string' && f[k].length > 1 && f[k][0] === '/' && f[k].endsWith('/')) f[k] = new RegExp(f[k].slice(1, -1), 'i'); return f },
        options: (o) => Object.keys(o).length ? o : { pagination: false },
        update: (b) => b,
        create: (i) => i
      }
    : { ...compiled, ...(isPlainObject(opts.sanitizer) && opts.sanitizer) }

  return {
    url, Model, methods, scope, authorize, serialize, mapError, hooks, bulk, san, lateScope: createScope === 'after-hooks',
    lean: !!opts.lean, select: opts.select, routeOptions: opts.routeOptions ?? {}, handlers: opts.handlers ?? {},
    routes: opts.routes, actions: opts.actions ?? {},
    idIsObjectId: Model.schema.path('_id')?.instance === 'ObjectId',
    schemas: buildSchemas({ JSONSchema: opts.JSONSchema, readonly: new Set(readonly), schema: opts.schema, bulk })
  }
}

// ── Context: the toolbox shared by built-in handlers and your own ────────────
const createContext = (c) => {
  const { Model, hooks, san } = c
  const scope = async (req, action) => {
    if (req.crudify?.action === action) return req.crudify.filter // already resolved by this request's route
    if (!c.scope) return EMPTY
    const s = await c.scope(req, action)
    if (!isPlainObject(s)) throw forbidden() // fail closed
    return s
  }
  const where = async (req, action, base = {}) => composeFilter(base, await scope(req, action))
  const checkId = (id) => { if (c.idIsObjectId && !OBJECT_ID_RE.test(id)) throw notFound(id) }
  const find = async (req, action, id, lean) => {
    checkId(id)
    const doc = await Model.findOne(await where(req, action, { _id: id }), c.select, lean ? { lean: true } : undefined)
    if (!doc) throw notFound(id)
    return doc
  }
  const parseQuery = (q) => ({ filter: san.filter(parseJson(q.filters, 'filters')), options: san.options(parseJson(q.options, 'options')) })

  return Object.freeze({
    Model, url: c.url, scope, where, checkId, notFound, find,
    load: (req, action = 'get', id = req.params.id) => find(req, action, id, false), // a real document: you can .save() it
    list: async (req) => {
      const { filter, options } = parseQuery(req.query)
      if (c.lean) options.lean = true
      if (c.select) options.select = c.select
      return Model.paginate(await where(req, 'list', filter), options)
    },
    sanitize: { ...san, query: (req) => parseQuery(req.query) },
    serialize: c.serialize ?? ((doc) => doc)
  })
}

const createHandlers = (c, ctx) => {
  const { Model, hooks } = c
  const { serialize } = ctx

  // Scope keys of a new document: `{ $in: [...] }` values must contain the document's own, equality values are forced.
  const checkLists = (data, lists) => {
    for (const field in lists) {
      const v = data[field]
      if (v === undefined) throw new CrudifyError(400, `${field} is required`, { code: 'validation_error' })
      if (!lists[field].some(x => String(x) === String(v))) throw forbidden()
    }
  }

  // 'strict' checks the client's document before `beforeCreate`; 'after-hooks' lets the hook derive the keys and checks
  // the FINAL document instead, forcing the equality keys last so a hook can never move a document out of its scope.
  const prepare = async (item, req, rules) => {
    const data = ctx.sanitize.create(item, rules.keys)
    for (const field in rules.inLists) if (item[field] !== undefined) data[field] = item[field]
    if (!c.lateScope) { checkLists(data, rules.inLists); Object.assign(data, rules.forced) }
    const out = hooks.beforeCreate ? (await hooks.beforeCreate(data, req)) ?? data : data
    if (!c.lateScope) return out
    checkLists(out, rules.inLists)
    return Object.assign(out, rules.forced)
  }

  return {
    list: async (req) => {
      let result = await ctx.list(req)
      if (hooks.afterList) result = (await hooks.afterList(result, req)) ?? result
      if (c.serialize) result.docs = result.docs.map(doc => serialize(doc, req))
      return result
    },

    get: async (req) => serialize(await ctx.find(req, 'get', req.params.id, c.lean), req),

    create: async (req, reply) => {
      const rules = writeRules(req.crudify.filter)
      const isBulk = Array.isArray(req.body)
      const data = []
      for (const item of isBulk ? req.body : [req.body]) data.push(await prepare(item, req, rules))
      let docs
      if (isBulk) { // build each document once (applies schema defaults) and validate all before writing: an invalid item inserts nothing
        const built = data.map(d => new Model(d))
        await Promise.all(built.map(d => d.validate()))
        docs = await (c.bulk.insertMany ? Model.insertMany(built) : Model.create(built, { validateBeforeSave: false })) // create() runs save hooks; already validated
      } else docs = await Model.create(data[0])
      if (hooks.afterCreate) await hooks.afterCreate(docs, req)
      reply.code(201)
      return isBulk ? { message: 'All documents created successfully' } : serialize(docs, req)
    },

    update: async (req) => {
      const { id } = req.params
      const { filter } = req.crudify
      let changes = ctx.sanitize.update(req.body, writeRules(filter).keys)
      if (hooks.beforeUpdate) changes = (await hooks.beforeUpdate(changes, req)) ?? changes
      const doc = await Model.findOneAndUpdate(composeFilter({ _id: id }, filter), changes,
        { returnDocument: 'after', runValidators: true, projection: c.select, lean: c.lean })
      if (!doc) throw notFound(id)
      if (hooks.afterUpdate) await hooks.afterUpdate(doc, req)
      return serialize(doc, req)
    },

    delete: async (req) => {
      const { id } = req.params
      const filter = composeFilter({ _id: id }, req.crudify.filter)
      if (hooks.beforeDelete) { // needs the document: one extra query, only if you declare the hook
        const current = await Model.findOne(filter)
        if (!current) throw notFound(id)
        await hooks.beforeDelete(current, req)
      }
      const doc = await Model.findOneAndDelete(filter, { projection: c.select, lean: c.lean })
      if (!doc) throw notFound(id)
      if (hooks.afterDelete) await hooks.afterDelete(doc, req)
      return serialize(doc, req)
    }
  }
}

// ── The plugin ───────────────────────────────────────────────────────────────
async function Crudify (fastify, opts) {
  const c = normalizeOptions(opts, fastify.log)
  const ctx = createContext(c)
  const builtin = createHandlers(c, ctx)
  if (!fastify.hasRequestDecorator('crudify')) fastify.decorateRequest('crudify', null)

  const errorHandler = c.mapError === false ? undefined : (err, req, reply) => {
    const { status, body, level, meta } = c.mapError?.(err, req) ?? toErrorResponse(err)
    if (level) req.log[level](level === 'error' ? { err } : meta, level === 'error' ? 'crudify: unhandled error' : 'crudify: duplicate key')
    return reply.code(status).send(body)
  }

  // authorize -> scope -> handler, for built-in verbs and custom routes alike
  const begin = async (req, action, check) => {
    check?.(req)
    if (c.authorize && (await c.authorize(req, action)) === false) throw forbidden()
    req.crudify = { action, filter: await ctx.scope(req, action), doc: null }
  }

  const route = (method, path, { action = DEFAULT_ACTION[method] ?? 'update', load, ...routeOpts } = {}, handler, check) =>
    fastify.route({
      ...c.routeOptions,
      ...routeOpts,
      method,
      url: c.url + path,
      ...(errorHandler && { errorHandler }),
      handler: async (req, reply) => {
        await begin(req, action, check)
        if (load) req.crudify.doc = await ctx.load(req, action)
        return handler(req, reply, ctx)
      }
    })

  const checks = {
    get: (req) => ctx.checkId(req.params.id),
    update: (req) => ctx.checkId(req.params.id),
    delete: (req) => ctx.checkId(req.params.id),
    create: ({ body }) => {
      if (!Array.isArray(body)) {
        if (!isPlainObject(body)) throw new CrudifyError(400, 'Invalid request body', { code: 'invalid_body' })
      } else if (!c.bulk) throw new CrudifyError(400, 'Bulk create is disabled', { code: 'invalid_body' })
      else if (!body.length) throw new CrudifyError(400, 'Empty bulk body', { code: 'invalid_body' })
      else if (body.length > c.bulk.max) throw new CrudifyError(413, `Too many items (max ${c.bulk.max})`)
    }
  }

  for (const verb of c.methods) {
    const [method, path] = ROUTES[verb]
    route(method, path, { action: verb, schema: c.schemas[verb] }, c.handlers[verb] ?? builtin[verb], checks[verb])
  }

  const api = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(m =>
    [m, (path, a, b) => b ? route(m.toUpperCase(), path, a, b) : route(m.toUpperCase(), path, {}, a)]))
  await c.routes?.(api, ctx)

  for (const [name, { handler, method = 'POST', path = `/:id/${name}`, load = true, action = name, ...rest }] of Object.entries(c.actions)) {
    route(method.toUpperCase(), path, { ...rest, action, load }, handler)
  }

}

Crudify[Symbol.for('plugin-meta')] = { name: 'crudify-mongo', fastify: '4.x || 5.x' }
Crudify[Symbol.for('fastify.display-name')] = 'crudify-mongo'

export {
  Crudify,
  composeFilter,
  duplicateKeyFields,
  isDuplicateKeyError,
  toErrorResponse
}
