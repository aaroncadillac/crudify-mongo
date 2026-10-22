# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/).

## [2.0.0] - 2026-10-21

Crudify is now **secure by default** and extensible. The plugin that used to hand raw client input to Mongo (and made every real application re-implement it) now sanitizes queries and bodies, bounds results, hides internals from error responses and offers `scope` / `authorize` / hooks / custom routes as first-class seams. It stays small: two files, no runtime dependencies. It does **not** authenticate or authorize by itself; it gives you the points where your tool of choice (`@fastify/auth`, Casbin, JWT...) plugs in.

### ⚠ BREAKING

- **Paginated by default.** `GET /` returns 50 documents per page and never more than 100. `pagination: false` (which used to be the default) and any client `populate`, `select`, `lean`, `collation`, `offset`... are ignored. Raise the cap per resource with `query.maxLimit`.
- **`filters` are sanitized.** Only a short allowlist of operators, bounded depth and size. `"/text/"` is now an *escaped literal* (case-insensitive "contains"), no longer a client-controlled regular expression. `$where`, `$expr`, `$regex`, `$text`, `$function`... are rejected with `400`.
- **Updates (`PUT`) are filtered.** `_id`, `__v`, `createdAt` / `updatedAt` (and custom timestamp names) and your `fields.readonly` / scope keys are dropped silently; only plain fields, dotted paths, `$set` and `$unset` are accepted (the others answer `400`); an update with nothing valid left is a `400`. Creates drop the same fields.
- **Error responses changed.** One shape for every error: `{ status, error, message, code? }` (the 404 body is unchanged). Validation and cast errors are `400` everywhere (a cast error or a non-`required` validation error on `PUT` was a `500`), duplicate keys are a generic `409`, and every unexpected error is `500 Internal error`: `err.message` is no longer sent to clients.
- **`POST` with an array** goes through `Model.create` (so `pre/post('save')` hooks run), validates every item before inserting any, and is limited to `bulk.max` (default 100, `413` above it). The old `insertMany` behaviour is available with `bulk: { insertMany: true }`.
- **`opts.schema`** is now per verb: `{ list, get, create, update, delete }`, and it is merged over the generated schemas instead of replacing them.
- **`exports` map.** The package exposes `.` and `./sanitizer`; deep imports such as `.../crudify.js` no longer resolve. `engines.node` is `>=20`; `fastify` (^4 or ^5), `mongoose` (^8) and `mongoose-paginate-v2` are peer dependencies.
- **The plugin is async** (no `next` callback). It still registers with `fastify.register(Crudify, options)`.

### Added

- **Sanitizer module**, on by default, usable on its own via `@aaroncadillac/crudify-mongo/sanitizer`: `createSanitizer`, `sanitizeFilter`, `sanitizeOptions`, `sanitizeUpdate`, `sanitizeCreate`, `parseJson`, `escapeRegex`, `CrudifyError`. Configure it with `query` and `fields`, replace pieces with `sanitizer: { filter, options, update, create }`, or disable it with `sanitizer: false`.
- **`scope(req, action)`**: a server-side filter ANDed with every read and write (no IDOR), forced into new documents, protected from updates. Fails closed.
- **`authorize(req, action)`**: runs before any I/O; deny by throwing or returning `false`.
- **Hooks**: `beforeCreate`, `afterCreate`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`, `afterList`. **`serialize`** and **`mapError`**.
- **`methods`** to register only some verbs; **`fields`** (`writable`, `readonly`, `hidden`); **`bulk`**; **`lean`**; **`select`**; **`routeOptions`**.
- **Custom endpoints**: `routes(api, ctx)`, `actions`, and per-verb `handlers`, all sharing scope, authorize and error handling through a context `ctx` (`where`, `load`, `list`, `sanitize`, `serialize`...). `req.crudify = { action, filter, doc }`.
- **`CrudifyError`** and the pure helpers `toErrorResponse`, `composeFilter`, `isDuplicateKeyError`, `duplicateKeyFields`.
- **`strict: true`** fails at startup if `scope` is missing or the sanitizer is off.
- Fastify **4 and 5** support, validated by the test suite against both.
- `example/` with `@fastify/auth`, two tenants, roles and a custom action; `bench/run.js`; this changelog.

### Changed

- Registration validates its options and throws immediately on mistakes (unknown verbs, missing `paginate`, non-function hooks, forbidden operators...).
- Everything computable is computed once at registration (see the benchmark in the README).
- Route options are built explicitly, so `Model`, `url` and `JSONSchema` no longer leak into Fastify's route options.

### Deprecated

- `additionalRoutes` (both the function form and the array form the old README described). Use `routes` or `actions`. It still works and logs a warning; it will be removed in 3.0.

### Fixed

- With `JSONSchema`, the list response schema is now the paginate shape (it described a bare array) and `POST` accepts the bulk array (it only allowed an object); generated schemas no longer drop the ones you supply, and `required` is not enforced on responses.
- `POST` with an array no longer bypasses `pre/post('save')` hooks.
- `jest-mongodb-config` had a typo (`moduile.exports`) in an ESM package, so it was silently ignored; it is now `jest-mongodb-config.cjs`, wired through `MONGO_MEMORY_SERVER_FILE`, and uses a Mongo version with arm64 binaries.
- `example/` and the README now run as written (wrong export / import names, a model registered under the wrong name, a connection string that interpolated `undefined`).

### Security

- Raw client filters, options and bodies no longer reach Mongo: no operator injection, no ReDoS through client regex, no unbounded dumps, no `populate` / `select` of arbitrary relations, no mass assignment of `_id`, timestamps or ownership fields.
- Documents can be pinned to a scope on every verb, which closes cross-tenant reads, edits and deletes by id.
- Duplicate-key and internal errors no longer reveal collections, indexes, values or stack details (an email-enumeration oracle in 1.x).
- Fields marked `select: false` cannot be used as a search or sort oracle.

### Test coverage map

Each audited problem has a test; the suites live in `test/unit` (model stubbed, no database) and `test/integration` (real in-memory `mongod`), and every `crudify` suite runs against Fastify 4 **and** 5.

| ID | Problem in 1.8.2 | Where it is tested |
|---|---|---|
| C1 | raw operators in `filters` | `unit/sanitizer` · `unit/crudify` "reads" · `integration` "bounded queries" |
| C2 | client regex, ReDoS | `unit/sanitizer` (escaped literal, timing) · `integration` "a catastrophic regex" |
| C3 | raw `options`, `pagination:false` default | `unit/sanitizer` sanitizeOptions · `unit/crudify` "caps the limit" · `integration` "defaults to 50" |
| C4 | no tenant: `findById` / update / delete by `_id` only | `unit/crudify` "scope on every verb" · `integration` "tenant isolation" |
| C5 | mass assignment in `PUT` | `unit/sanitizer` sanitizeUpdate · `integration` "ignores _id, timestamps..." |
| C6 | bulk `insertMany` skips save hooks | `unit/crudify` "bulk create" · `integration` "bulk create runs the save hooks" |
| C7 | every error is `500 err.message` (leaks E11000) | `unit/errors` · `integration` "real duplicate key" |
| C8 | inconsistent validation errors | `unit/errors` · `unit/crudify` "same body shape" · `integration` "validation and cast errors" |
| C9 | no hooks / authorization points | `unit/crudify` "hooks, authorize and serialize" |
| C10 | cannot disable verbs | `unit/crudify` and `integration` "methods" |
| C11 | `additionalRoutes` README / code mismatch | `unit/crudify` and `integration` "additionalRoutes" · `integration/example` |
| C12 | options clobbered / leaked into routes | `unit/crudify` "does not leak plugin options" · "per-verb Fastify schema" |
| C13 | no validation without an undeclared dependency | `unit/crudify` and `integration` "JSONSchema" (hand-written schemas are enough) |
| C14 | unbounded bulk | `unit/crudify` and `integration` "bounds the bulk size" |
| C15 | plugin composition (async, prefix, parent hooks) | `unit/crudify` "registers under a prefix", "plugin metadata" |
| C16 | happy-path-only tests, Fastify 5 untested | the whole suite; Fastify 4 + 5 matrix (`test/helpers/fastifies.js`) |
| C17 | broken README / example | `integration/example` (the example app runs, with `@fastify/auth`) |
| C18 | wrong list response schema | `unit/crudify` and `integration` "JSONSchema" |
| C19 | schema rejected the bulk array | `unit/crudify` and `integration` "JSONSchema" |
| C20 | `select:false` fields usable as a search oracle | `unit/sanitizer` hidden · `integration` "select:false" · `integration/example` |
| C21 | broken jest-mongodb config | `jest.config.js` + `jest-mongodb-config.cjs` (the integration project runs on it) |
| C22 | example model name / connection string | `integration/example` |
| C23 | publishes without running tests | **pending**: `.github/workflows` was not changed (see TODO.md) |
| C24 | Mongoose mutates shared option objects | `unit/crudify` "does not reuse option objects" |
| C25 | `fastify-plugin` not needed (a plain plugin inherits parent hooks / decorators) | `unit/crudify` "inherits hooks of the parent", "prefix" |

Needs of the first real consumer (a multi-tenant restaurant API) are covered too: tenant isolation, authorize by verb, operator allowlist, limits, writable / readonly fields, tenant forcing on create, `methods`, consistent errors, bulk, custom routes and actions with shared scope (`integration` "custom routes and actions share scope + authorize").

## Migration guide: 1.x → 2.0

| In 1.x | In 2.0 | If you need the old behaviour |
|---|---|---|
| `GET /` returned everything | 50 per page, max 100 | `query: { defaultLimit, maxLimit }`; there is no "all rows" mode, page through the results |
| Any Mongo operator in `filters` | Allowlisted operators | `query: { operators: [...DEFAULT_OPERATORS, '$size', '$all', '$nor'] }`, or `sanitizer: false` (not recommended) |
| `"/text/"` = client regex | escaped literal ("contains") | `query: { search: 'prefix' }` for an indexable prefix; nothing to restore the raw regex |
| `options: { populate, select, lean }` honoured | ignored | `query: { populate: ['owner'] }` allowlists populate paths; `lean` and `select` are plugin options |
| `PUT` body went straight to Mongo | filtered, flat `$set` / `$unset` only | `fields: { writable: [...] }` to be stricter; a `beforeUpdate` hook to reshape |
| Errors `{ error: err.message }` with status 500 | `{ status, error, message, code? }` | `mapError: (err) => ({ status, body })` |
| `POST` validation errors were `400` with a raw message; on `PUT` only `required` errors were `400`, the rest `500` | `400` with one shape everywhere | |
| `additionalRoutes` | deprecated | `routes(api, ctx)` or `actions` |
| `opts.schema` replaced the generated schema | per verb, merged | `schema: { update: { body } }` |
| No scope | `scope` / `authorize` (warns when `scope` is missing) | `scope: false` to say "no restriction"; `strict: true` to forbid it |
| Bulk with `insertMany` | `Model.create` (hooks run) | `bulk: { insertMany: true }` |
| `import '@aaroncadillac/crudify-mongo/crudify.js'` | not exported | `import { Crudify } from '@aaroncadillac/crudify-mongo'` |

Clients keep working if they only used the documented routes, the `docs` / `totalDocs` pagination fields and `{ status, error, message }` for 404s. Review any client that relied on the `error` field containing a human message (it is now the HTTP status text; the message is in `message`) or on a list returning more than 100 rows.

## [1.8.2]

Last 1.x release. See the git history.
