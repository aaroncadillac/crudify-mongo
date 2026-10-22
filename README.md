# Crudify Mongo

[![License: MPL-2.0](https://img.shields.io/badge/License-MPL--2.0-blue.svg)](https://opensource.org/licenses/MPL-2.0)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/aaroncadillac/crudify-mongo/test.yml)
![NPM Version](https://img.shields.io/npm/v/%40aaroncadillac%2Fcrudify-mongo)

A CRUD generator for [Fastify](https://fastify.dev) and [Mongoose](https://mongoosejs.com) that is **safe to expose by default**: client queries are sanitized, results are bounded, errors never leak internals, and every read and write can be pinned to a server-side scope. It is small (two files, no runtime dependencies) and extensible through hooks and custom routes.

> Upgrading from 1.x? Read the [migration guide](CHANGELOG.md#migration-guide-1x--20).

- [Install](#install)
- [Quick start](#quick-start)
- [Secure by default](#secure-by-default)
- [Authentication and authorization](#authentication-and-authorization)
- [Query language](#query-language)
- [Options](#options)
- [Errors](#errors)
- [Scope and authorize](#scope-and-authorize)
- [Hooks and request order](#hooks-and-request-order)
- [Custom routes, actions and overrides](#custom-routes-actions-and-overrides)
- [Recipes](#recipes)
- [The sanitizer on its own](#the-sanitizer-on-its-own)
- [JSON Schema and Swagger](#json-schema-and-swagger)
- [Performance](#performance)

## Install

```bash
yarn add @aaroncadillac/crudify-mongo
```

Requires Node >= 22, Fastify 4 or 5, Mongoose 8 and, for the list route, [mongoose-paginate-v2](https://www.npmjs.com/package/mongoose-paginate-v2) >= 1.8. They are peer dependencies: Crudify imports none of them.

## Quick start

```js
import Fastify from 'fastify'
import mongoose from 'mongoose'
import paginate from 'mongoose-paginate-v2'
import { Crudify } from '@aaroncadillac/crudify-mongo'

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true }
}, { timestamps: true })
userSchema.plugin(paginate) // required by the list route

const User = mongoose.model('Users', userSchema)

await mongoose.connect(process.env.MONGODB_URL)

const app = Fastify({ logger: true })
app.register(Crudify, { url: '/users', Model: User, scope: false }) // see "Scope and authorize"
await app.listen({ port: 3000 })
```

| Route | Does | Built in |
|---|---|---|
| `GET /users` | paginated list | sanitized `filters` / `options`, limit cap |
| `GET /users/:id` | one document | 404 when missing or out of scope |
| `POST /users` | create one document, or an array (bulk) | schema validation, save hooks run |
| `PUT /users/:id` | update fields | only your writable fields, validators run |
| `DELETE /users/:id` | delete | 404 when missing or out of scope |

The URLs and response shapes are the same as in 1.x. A runnable example with authentication, two tenants and a custom action lives in [`example/`](example/).

## Secure by default

Without any configuration:

- `filters` accept a short allowlist of operators with bounded depth and size. `$where`, `$expr`, `$function`, `$regex`, `$text` and friends are refused.
- `"/text/"` searches are **escaped literals**, never a client-supplied regex, so they cannot be used for ReDoS.
- `options` only honour `page`, `limit` and `sort`. `limit` defaults to 50 and is capped at 100; `populate`, `select`, `lean` and `pagination: false` from the client are ignored.
- Writes drop `_id`, `__v` and the timestamps, accept no update operators besides `$set` / `$unset`, and refuse operators nested inside values.
- Fields with `select: false` in your schema cannot be filtered or sorted on (it would be a search oracle).
- Bulk creation goes through `Model.create`, so `pre('save')` / `post('save')` hooks always run, and an invalid item inserts nothing.
- Errors are mapped to a fixed shape. Duplicate keys become a generic `409`; unexpected errors become `500 Internal error` (the detail goes to your logs, never to the client).
- Invalid ids answer `404` without touching the database.

What it does **not** do on its own is decide *who* may see *which* documents. That is what `authorize` and `scope` are for.

## Authentication and authorization

Crudify does **not** authenticate users and does not include any permission system. It stays out of that on purpose and gives you two seams so any tool can plug in: [`@fastify/auth`](https://github.com/fastify/fastify-auth), JWT plugins, sessions, Casbin, your own checks.

1. Authenticate with a Fastify hook or `routeOptions.preHandler` (this is where `req.user` gets set).
2. `authorize(req, action)` answers *may this user do this action?* and throws (or returns `false`) to deny.
3. `scope(req, action)` answers *which documents is this user limited to?* and returns a Mongo filter.

[`example/app.js`](example/app.js) is a complete, tested setup with `@fastify/auth`, two accounts and roles. A Casbin recipe is under [Recipes](#recipes).

## Query language

Query params are JSON strings:

```
GET /users?filters={"age":{"$gte":18},"name":"/ana/"}&options={"page":2,"limit":20,"sort":"-createdAt name"}
```

| Piece | Allowed |
|---|---|
| Comparison | `$eq $ne $gt $gte $lt $lte` with plain values |
| Lists | `$in $nin` (and `$all`, opt-in) with arrays of plain values |
| Other | `$exists` (boolean); `$size` (opt-in) |
| Logical | `$or $and` (and `$nor`, opt-in), non-empty arrays |
| Text | `"/text/"` as a value: case-insensitive *contains* on an escaped literal (`query.search: 'prefix'` makes it `^text`, which can use an index) |
| Sort | a string (`"-createdAt name"`) or an object (`{"name": 1}`), field names validated |
| Never | `$where $expr $function $accumulator $regex $text $jsonSchema $elemMatch` |

The default limits (all configurable through `query`) are depth 4, 100 keys, 1000 array items, 20 branches per `$or`/`$and`, 64 characters of search text and 5 sort fields. Anything else is a `400` with `code: "invalid_query"`.

## Options

`fastify.register(Crudify, options)`:

| Option | Default | Meaning |
|---|---|---|
| `url` | required | Base path, e.g. `/users`. May contain params: `/orders/:orderId/lines` |
| `Model` | required | Mongoose model (with `paginate` if `list` is enabled) |
| `methods` | all five | Subset of `list get create update delete` |
| `scope` | none (warns) | `(req, action) => filter`, or `false` for "no restriction" |
| `authorize` | none | `(req, action) => void`; throw or return `false` to deny |
| `hooks` | `{}` | `beforeCreate afterCreate beforeUpdate afterUpdate beforeDelete afterDelete afterList` |
| `serialize` | none | `(doc, req) => object`, applied to every document sent |
| `mapError` | built in | `(err, req) => ({ status, body }) \| undefined`; `false` to use the app's own error handler |
| `query` | see below | Sanitizer settings for `filters` / `options` |
| `fields` | none | `writable` (allowlist), `readonly` (denylist), `hidden` (not filterable) |
| `bulk` | `{ max: 100, insertMany: false }` | Bulk create limits; `false` disables arrays |
| `lean` | `false` | Return plain objects (faster; skips getters, virtuals and `toJSON` transforms) |
| `select` | none | Fixed projection for reads and updates |
| `sanitizer` | `true` | `false` disables it (1.x behaviour, logs a warning) or pass `{ filter, options, update, create }` to replace pieces |
| `JSONSchema` | none | JSON Schema of the model: validates bodies and serializes responses |
| `schema` | none | Fastify schema per verb: `{ list, get, create, update, delete }` |
| `routeOptions` | `{}` | Fastify route options for every route (`preHandler`, `config`, `bodyLimit`...) |
| `handlers` | none | Replace one built-in verb: `{ create: (req, reply, ctx) => ... }` |
| `routes` | none | `(api, ctx) => void`: add your own routes |
| `actions` | none | Non-CRUD operations on one document, see below |
| `strict` | `false` | Throw at startup if `scope` is missing or the sanitizer is disabled |
| `createScope` | `'strict'` | When the scope's `{ $in }` keys are checked on create: `'strict'` (before `beforeCreate`) or `'after-hooks'` (on the final document), see "Deriving a scope key" |

`query`: `operators`, `maxDepth`, `maxKeys`, `maxArray`, `maxBranches`, `search` (`'contains' | 'prefix' | false`), `maxSearchLength`, `filterable` (allowlist of root fields), `defaultLimit` (50), `maxLimit` (100), `maxSort`, `populate` (paths a client may populate).

`createdAt`, `updatedAt` (including custom names from `timestamps`), `_id`, `__v` and the root keys of your scope are always read-only for clients. Registering the plugin with invalid options throws immediately.

## Errors

Every error uses one body, the same `{ status, error, message }` shape the 404 always had, plus an optional `code`:

| Case | Status | Notes |
|---|---|---|
| Not found, out of scope, invalid id | 404 | `ID: <id> not found` |
| Invalid query, body or operators | 400 | `code: "invalid_query"` / `"invalid_body"` |
| Mongoose validation | 400 | `Fields: [a, b] are required and cannot be empty`, or `Invalid fields: [...]` with `details.fields`; custom messages stay private |
| Cast error | 400 | `Invalid value for "<path>"` |
| `authorize` / `scope` deny | 403 | `Forbidden` (or your `CrudifyError`) |
| Bulk over `bulk.max` | 413 | |
| Duplicate key (E11000) | 409 | `code: "duplicate_key"`; **never** the collection, index or value |
| Version conflict | 409 | `code: "version_conflict"` |
| Anything else | 500 | `Internal error`; the real error is logged |

To show a message to the client from your own code, throw a `CrudifyError`:

```js
import { CrudifyError } from '@aaroncadillac/crudify-mongo'
throw new CrudifyError(409, 'This order is already paid', { code: 'order_paid' })
```

`toErrorResponse(err)` is exported if you want the same mapping in your own `setErrorHandler`.

## Scope and authorize

`scope` is a filter ANDed with every read and write, so a document outside it is simply "not found":

```js
app.register(Crudify, {
  url: '/orders',
  Model: Order,
  scope: (req) => ({ accountId: req.user.accountId })
})
```

- **list / get / update / delete:** the scope is combined with the client filter and the id. If a key collides (the client also filters on `accountId`), both conditions are kept with `$and`, so the client can never override the scope.
- **create:** root keys with an equality value are *forced* into the new document (the client value is ignored). With `{ $in: [...] }` the client must send a value from the list (`400` if missing, `403` if not allowed).
- **update:** root keys of the scope can't be rewritten, so a document can never be moved out of its scope. If your scope uses `$or`, list the involved fields in `fields.readonly`.
- `scope` must return a plain object. Anything else is a `403` (fail closed). Return `{}` to say "no restriction" explicitly, or pass `scope: false`.
- `authorize` runs first, before any query. Use it for role checks that don't depend on the document; use `scope` for anything about *which* documents (it is atomic: no read-then-check race).

### Deriving a scope key in `beforeCreate` (`createScope`)

Sometimes the client does not send the scope key because it is *derived*: an order carries `tableIds`, and its `restaurantId` comes from those tables. By default (`createScope: 'strict'`, the behaviour of 3.0.0) Crudify demands the `{ $in }` key **before** `beforeCreate` runs, so such a resource answers `400 restaurantId is required`.

With `createScope: 'after-hooks'` the create pipeline becomes:

1. sanitize the client document (scope keys the client sent are kept, forced equality keys are dropped);
2. run `beforeCreate(data, req)`, which can derive or stamp the key;
3. **validate the final document**: every `{ $in }` key must exist (`400 <field> is required`) and be in the list (`403 Forbidden`);
4. impose the equality keys last, so the hook cannot overwrite them.

```js
app.register(Crudify, {
  url: '/orders',
  Model: Order,
  createScope: 'after-hooks',
  scope: async (req) => ({
    accountId: req.user.accountId,
    restaurantId: { $in: await allowedRestaurantIds(req.user) } // e.g. from your permission system
  }),
  hooks: {
    // `data` has no accountId yet: it is forced after this hook
    beforeCreate: async (data) => {
      const tables = await Table.find({ _id: { $in: data.tableIds ?? [] } }).lean()
      const restaurants = new Set(tables.map(t => String(t.restaurantId)))
      if (tables.length !== data.tableIds?.length || restaurants.size !== 1) {
        throw new CrudifyError(400, 'tableIds must belong to a single restaurant')
      }
      return { ...data, restaurantId: [...restaurants][0] }
    }
  }
})
```

What stays guaranteed: a hook can derive the key but **never move a document out of its scope**, because Crudify checks the result and forces the equality keys itself. Bulk requests are validated entirely before anything is written. `list`, `get`, `update` and `delete` are not affected.

What you take on by choosing it:

- `beforeCreate` receives the document **without the forced keys** (`accountId` above is not there yet). Don't rely on them inside the hook.
- The hook must derive the key from trusted data (look it up in your database; never copy it from another client-supplied field without checking).
- A hook that derives nothing is a `400`, and one that derives a value outside the caller's list is a `403`.

Not recommended: setting `scope: {}` for the action and validating the tenant yourself inside `beforeCreate`. It works, but then nothing is checked by Crudify and a forgotten check is a cross-tenant leak; that risk is entirely yours.

## Hooks and request order

```js
app.register(Crudify, {
  url: '/orders',
  Model: Order,
  hooks: {
    beforeCreate: async (data, req) => ({ ...data, createdBy: req.user.id }), // return the (new) data
    afterCreate: async (docOrDocs, req) => {},
    beforeUpdate: async (changes, req) => changes,
    afterUpdate: async (doc, req) => {},
    beforeDelete: async (doc, req) => { if (doc.paid) throw new CrudifyError(409, 'Paid orders cannot be deleted') },
    afterDelete: async (doc, req) => {},
    afterList: async (result, req) => result // the paginate result; return it or a new one
  }
})
```

Order for every request: Fastify hooks and schema validation, `routeOptions.preHandler`, cheap structural checks (id format, body shape, bulk size), `authorize`, `scope`, sanitizing, `before*`, the Mongo operation, `after*`, `serialize`. Any hook can stop the request by throwing a `CrudifyError`. Declaring `beforeDelete` costs one extra query (it needs the document); without it, delete is a single `findOneAndDelete`. An error thrown from an `after*` hook happens after the write: use `onResponse` for non-critical side effects.

`req.crudify` is `{ action, filter, doc }` for the current request, readable from your own Fastify hooks.

## Custom routes, actions and overrides

Everything below shares the same `authorize`, `scope` and error handling as the built-in verbs, and receives a context `ctx`:

```js
app.register(Crudify, {
  url: '/orders',
  Model: Order,
  scope: (req) => ({ accountId: req.user.accountId }),
  authorize: (req, action) => { if (action === 'close' && req.user.role !== 'admin') throw new CrudifyError(403, 'Admins only') },

  // 1. an action on one document: POST /orders/:id/close (the document arrives loaded, in scope)
  actions: {
    close: {
      handler: async (req, reply, ctx) => {
        const order = req.crudify.doc
        order.status = 'closed'
        await order.save()
        return ctx.serialize(order, req)
      }
    }
  },

  // 2. free-form routes
  routes: (api) => {
    api.get('/stats', { action: 'list' }, async (req, reply, ctx) => ({
      open: await ctx.Model.countDocuments(await ctx.where(req, 'list', { status: 'open' }))
    }))
    api.get('/:id/light', { load: true }, async (req) => ({ id: req.crudify.doc._id }))
  },

  // 3. replace one built-in verb, keeping authorize + scope
  handlers: {
    list: async (req, reply, ctx) => ({ total: (await ctx.list(req)).totalDocs })
  }
})
```

`actions.<name>` options: `handler`, `method` (`POST`), `path` (`/:id/<name>`), `load` (`true`), `action` (the name given to `authorize`/`scope`, default the key), plus any Fastify route option such as `schema`.

`api.get|post|put|patch|delete(path, [options], handler)`; options are Fastify route options plus `action` (what `authorize`/`scope` see; defaults to `get` for GET, `delete` for DELETE, `update` otherwise) and `load` (load the document into `req.crudify.doc`).

`ctx` has `Model`, `url`, `scope(req, action)`, `where(req, action, base)` (a filter with the scope applied), `load(req, action, id)` (a real Mongoose document, or 404), `list(req)` (sanitized + scoped paginate), `sanitize.{filter, options, update, create, query}`, `serialize`, `notFound` and `checkId`.

> `additionalRoutes` (deprecated in 2.x) was removed: passing it throws at registration. Use `routes` or `actions`.

## Recipes

**A tenant resource in five lines.** Multi-tenancy is your domain, so keep the factory in your app:

```js
const owned = (url, Model, extra = {}) => ({ url, Model, scope: (req) => ({ accountId: req.user.accountId }), ...extra })
app.register(Crudify, owned('/tables', Table))
app.register(Crudify, owned('/menus', Menu, { methods: ['list', 'get'] }))
```

**Sub-resources.** The parent id is just part of the URL and the scope:

```js
app.register(Crudify, {
  url: '/orders/:orderId/lines',
  Model: Line,
  scope: async (req) => {
    if (!(await Order.exists({ _id: req.params.orderId, accountId: req.user.accountId }))) throw new CrudifyError(404, 'Not found')
    return { orderId: req.params.orderId } // forced on create, ANDed on the rest
  }
})
```

**Casbin** (or any policy engine), with no extra dependency in Crudify:

```js
const ACTION = { list: 'read', get: 'read', create: 'create', update: 'update', delete: 'delete' }

app.register(Crudify, {
  url: '/orders',
  Model: Order,
  authorize: async (req, action) => {
    const allowed = await enforcer.enforce(req.user.id, req.user.accountId, 'orders', ACTION[action] ?? action)
    if (!allowed) throw new CrudifyError(403, 'Forbidden')
  },
  scope: (req) => ({ accountId: req.user.accountId }) // the policy domain doubles as the data scope
})
```

**Hide fields from responses:**

```js
serialize: (doc) => { const { passwordHash, ...rest } = doc.toObject({ flattenObjectIds: true }); return rest }
```

## The sanitizer on its own

The sanitizer is a separate module you can use in your own handlers:

```js
import { sanitizeFilter, sanitizeOptions, sanitizeUpdate, createSanitizer, parseJson } from '@aaroncadillac/crudify-mongo/sanitizer'

const filter = sanitizeFilter(parseJson(req.query.filters, 'filters'), { maxDepth: 2 })
const { filter: f, options, update, create } = createSanitizer({ maxLimit: 25, writable: ['name'] }) // compile once, reuse
```

Pass `sanitizer: { filter: myFn }` to Crudify to replace a piece, or `sanitizer: false` to turn it off (not recommended).

## JSON Schema and Swagger

Give Crudify the JSON Schema of your model (for example from [`mongoose-schema-jsonschema`](https://github.com/DScheglov/mongoose-schema-jsonschema)) and it validates bodies and serializes responses with it:

```js
app.register(Crudify, { url: '/users', Model: User, JSONSchema: userJsonSchema, scope: false })
```

The list response is typed as the paginate result, `POST` accepts one object or an array, read-only fields are removed from the body schema (so a key forced by your scope is never "required" from the client), and `x-ref` keys are stripped. Responses drop `required`, so `select` and `serialize` can hide fields freely. Use `schema: { list: {...}, ... }` to override any verb, and `@fastify/swagger` picks everything up.

## Performance

Everything that can be computed is computed once at registration: allowlist `Set`s, the sanitizer, route schemas, error handler and the context. Per request there is a single `JSON.parse` for each query param, one pass of the sanitizer that builds its output directly, one query (paginate does two) and no `try/catch` per route. `node bench/run.js` (no extra dependencies) measures it; on an Apple-silicon laptop with a stubbed model, a typical filter sanitizes in about 0.8 µs and Crudify adds roughly 0.5-0.8 µs per request over a bare Fastify route. `lean: true` skips Mongoose document hydration on reads when you don't need getters, virtuals or `toJSON` transforms.

## Acknowledgements

Inspired by [fastify-mongoose-crud](https://github.com/paranoiasystem/fastify-autocrud).

## License

[Mozilla Public License 2.0](/LICENSE)
