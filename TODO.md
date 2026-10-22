# TODO — Crudify v2: ligero, seguro por defecto y extensible

> **Estado (2026-10-21): implementado en 2.0.0** (sin publicar). Las casillas marcadas están hechas y probadas; lo pendiente está en §8. Detalle de cambios y mapa C→test en `CHANGELOG.md`.

Origen: Igor dejó de usar `@aaroncadillac/crudify-mongo` el 2026-10-21. Se reemplazó por un `ScopedCrud` propio (`igor-server/src/plugins/scopedCrud.js`, `tenancy/resourceScopes.js`, `utils/querySanitizer.js`) porque Crudify 1.8.2 no daba forma de cerrar fugas entre tenants ni de personalizar endpoints sin escribir controladores aparte. Este documento baja ese aprendizaje al plugin. Análisis hecho sobre `crudify.js` (213 líneas, idéntico a lo publicado) y el uso real en Igor (~35 recursos registrados).

**Principios:** plugin pequeño (sin dependencias nuevas obligatorias, objetivo ≤ ~300 líneas en el núcleo), seguro por defecto, cada comportamiento de negocio entra por un *hook* o una *opción*, nunca por un fork. Todo cambio rompe lo mínimo posible: lo que hoy es inseguro pasa a ser opt-in explícito.

---

## 1. Qué encontré en `crudify.js` (evidencia)

| # | Problema | Dónde | Impacto en Igor |
|---|---|---|---|
| C1 | `filters` del cliente van directo a `Model.paginate` como JSON crudo: acepta cualquier operador Mongo (`$where`, `$expr`, `$regex` con ReDoS, etc.) | `crudify.js:95,104` | Listados globales con `GET /user?filters={}`; operadores peligrosos |
| C2 | Convención `"/texto/"` → `new RegExp(texto, 'i')` con la entrada del cliente sin escapar ni acotar | `:98-100` | ReDoS y búsquedas no indexables |
| C3 | `options` del cliente directo a `paginate`: permite `populate`, `select`, `lean`, `collation`, `limit` sin tope y `pagination:false` (que además es el **default**) | `:103-104` | Dump completo de colecciones y populate de relaciones ajenas |
| C4 | Sin noción de tenant/propietario: `findById`, `findOneAndUpdate({_id})` y `findOneAndDelete({_id})` buscan solo por `_id` | `:112,155,189` | IDOR: cualquier id de otra cuenta se lee, edita o borra |
| C5 | El PUT pasa `req.body` completo a `findOneAndUpdate`: mass assignment (`owner`, `accountId`, `_id`, operadores `$set`/`$rename`, etc.) | `:155` | Reasignar propiedad de documentos entre cuentas |
| C6 | El POST en bulk usa `insertMany`, que **no** dispara `pre/post('save')` (sí `Model.create` en el caso unitario) | `:142` vs `:145` | Hooks de dominio y auditoría se saltan según el tamaño del body |
| C7 | Todos los errores salen como `500 { error: err.message }`: filtra colección, índice y valor del E11000 y mensajes internos; los `ValidationError`/`CastError` también son 500 | `:106,123,149,182,200` | Enumeración de correos (N-15) y fuga de detalles de la base |
| C8 | El único tratamiento de errores de validación es el del PUT (campos `required`); el POST devuelve `err.message` crudo con 400 | `:133-136,153-182` | Respuestas inconsistentes entre verbos |
| C9 | Sin hooks de ciclo de vida ni de autorización: no hay `preHandler` por verbo, ni `beforeCreate`/`afterUpdate`, ni scope por request | todo el archivo | Obligó a poner la autorización en `routes.js` fuera del plugin y a **reimplementar el plugin completo** |
| C10 | Sin forma de desactivar verbos: siempre registra los 5 | `:93-204` | Recursos de solo lectura (`/sale`, `/stock-movement`) quedaron expuestos a escritura hasta que el modelo rechazó el write |
| C11 | `additionalRoutes` se invoca como **función** `opts.additionalRoutes(fastify, opts)` (`:206-208`), pero el README documenta un **arreglo de objetos** `{method, url, handler}`. El README no coincide con el código | `:206-208` vs `README.md` | Documentación engañosa; quien siga el README rompe |
| C12 | `optsGetAll`/`optsGet`/`optsPost` pisan `opts.schema` (`schema: { response… }` sin `...opts.schema`) y el DELETE recibe `opts` completo (incluye `Model`, `url`, `JSONSchema` como opciones de ruta) | `:25-35,49-80,187` | Opciones de ruta ajenas se filtran a Fastify; schemas propios del usuario se pierden |
| C13 | El `schema` de respuesta solo existe con `JSONSchema` (requiere `mongoose-schema-jsonschema`, dependencia no declarada); sin él no hay validación de entrada ni serialización | `:19-45` | Sin schemas el body no se valida más allá de `Model.validate` |
| C14 | `Promise.all(req.body.map(Model.validate))` sin tope de ítems en el bulk | `:130` | Un body de 1 MB con miles de ítems; sin límite configurable |
| C15 | Sin `next`/`done` bien resuelto: la función es síncrona con `next()` y registra con `fastify.get` sin `fastify-plugin`; encapsulación por default | `:88,210` | Decoradores/hooks del padre no se heredan igual que con `fp`; difícil componer |
| C16 | Pruebas solo "camino feliz" (5 casos); ninguna de errores, seguridad, filtros ni bulk. `test` usa `yarn bin jest` y Fastify 4 en dev pero el consumidor usa Fastify 5 | `test/crudify.test.js` | Sin red de seguridad para refactorizar; compatibilidad con Fastify 5 sin probar |
| C17 | `example/routes.js` registra `AutoCrud` (nombre viejo, sin import); `README` usa `import Crudify from 'crudify-mongo'` (nombre y export incorrectos) | `example/routes.js`, `README.md` | Ejemplos que no corren |

## 2. Qué tuve que construir en Igor porque Crudify no lo daba

Cada fila es un requisito real que terminó como código fuera del plugin (y por tanto un candidato a entrar como opción/hook).

| Necesidad real | Cómo se resolvió en Igor | Qué debería ofrecer Crudify |
|---|---|---|
| Aislar por tenant (cuenta/restaurante) en cada verbo | `tenancy/resourceScopes.js` (filtro AND por request + validación de campos en create) | Hook `scope(req, action) → filter` obligatorio u opt-out explícito |
| Autorizar por verbo y recurso | `requireCrudPermission`/Casbin en `routes.js`, luego integrado en el scope | `authorize(req, action, doc?)` o `preHandler` por verbo |
| Limitar operadores de filtro y regex del cliente | `utils/querySanitizer.js` (`sanitizeFilter`) | Allowlist de operadores configurable, `/texto/` escapado y acotado |
| Limitar `options` (page, limit, sort) | `sanitizeOptions` con topes por recurso (100 / 1000) | `maxLimit` y `defaultLimit` por recurso; `pagination:false` fuera |
| Allowlist/denylist de campos escribibles | `sanitizeUpdate` + `denyFields`/`allowFields` por recurso | `writableFields` / `readonlyFields` por recurso |
| Forzar campos de tenant en el create e ignorar los del body | `prepareCreate` en cada scope | Hook `beforeCreate(doc, req)` que puede mutar/rechazar |
| Recursos de solo lectura o sin delete | Se dejaron de registrar rutas (`methods: [...]`) | Opción `methods` |
| Errores consistentes (400 validación, 404, 409 duplicado, 500 sin detalles) | Mapeo propio + `plugins/duplicateKeyGuard.js` + `setErrorHandler` | `errorMapper` por defecto seguro y sobreescribible |
| Que corran los hooks de Mongoose en bulk | `Model.create([...])` en vez de `insertMany` | Es un bug (C6): corregir |
| Endpoints custom por recurso sin ensuciar `routes.js` | ~10 controladores nuevos + `routes.js` largo | Ver §4: rutas custom con acceso al mismo contexto (scope/auth/errores) |

## 3. Propuesta de diseño (núcleo ligero)

El núcleo hace solo: **parseo/validación segura de query → llamada al Model → serialización/errores**. Todo lo demás es un hook. Sin dependencias nuevas obligatorias; `fastify-plugin` y `mongoose-paginate-v2` como peer.

```js
// Registro mínimo (seguro por defecto)
fastify.register(Crudify, {
  url: '/users',
  Model: UserModel,
  methods: ['list', 'get', 'create', 'update', 'delete'],   // por defecto los 5
  limits: { defaultLimit: 50, maxLimit: 100, maxBulk: 100 },
  filter: { operators: ['$eq','$ne','$in','$nin','$gt','$gte','$lt','$lte','$exists','$or','$and'], regex: 'escaped' },
  fields: { writable: ['name', 'age', 'email'] },           // o readonly: ['owner']
  hooks: {
    scope: (req, action) => ({ accountId: req.user.accountId }),     // AND a TODA consulta; obligatorio u opt-out
    authorize: async (req, action, doc) => {},                       // lanzar CrudifyError(403)
    beforeCreate: async (data, req) => data,
    afterCreate: async (doc, req) => {},
    beforeUpdate: async (changes, doc, req) => changes,
    afterUpdate: async (doc, req) => {},
    beforeDelete: async (doc, req) => {},
    afterDelete: async (doc, req) => {},
    mapError: (err, req) => ({ status, body })                       // por defecto: 400/404/409/500 sin detalles
  },
  routes: (api) => {                                                  // rutas custom con el mismo contexto
    api.get('/:id/light-details', { action: 'get' }, async (req, reply, ctx) => ctx.findOne(req))
  }
})
```

### Decisiones propuestas (a validar)

- **Seguridad por defecto, rompiendo lo mínimo:** `maxLimit` por defecto (p. ej. 100) y `pagination:false` deja de ser el default; `populate`/`select` desde el cliente se ignoran salvo `allow: { populate: [...] }`. Un `scope` ausente emite warning al registrar (o falla en `strict: true`).
- **Errores:** clase `CrudifyError(status, code, message)` y mapeo estándar: `ValidationError`/`CastError` → 400, no encontrado → 404, `11000` → 409 `{ code: 'duplicate_key' }` sin colección/índice/valor, el resto → 500 `{ error: 'Internal error' }` con el detalle solo en el log.
- **Bulk:** `Model.create(items)` (hooks de `save` siempre corren) con `maxBulk`; documentar que `insertMany` queda como opt-in `bulk: 'insertMany'` si se prefiere velocidad.
- **PUT parcial seguro:** solo `$set`/`$unset` sobre campos permitidos; `_id`, `createdAt`, `updatedAt`, `__v` siempre fuera.
- **Encapsulación:** exportar con `fastify-plugin` (opción `encapsulate: false` por default) y usar `fastify.decorate`/`request` para exponer `req.crudify = { action, scope }` a hooks y rutas custom.
- **Compatibilidad:** peer `fastify >=4 <6`; probar en 4 y 5. `type: module` se mantiene.
- **Tamaño:** si pasa de ~300 líneas, partir en `query.js` (parseo), `errors.js`, `routes.js`, pero mantener un único import público.

## 4. Flexibilidad para endpoints propios (lo que más dolió)

El problema: para cualquier comportamiento distinto al CRUD plano hubo que escribir un controlador aparte, con su propio filtro de tenant, permisos y manejo de errores, duplicando lo que Crudify ya hacía. Propuestas:

- [x] **`routes` / `additionalRoutes` como API documentada** (hoy es una función no documentada, ver C11): recibir un helper `api` con `get/post/put/delete/patch` ya montado sobre `url`, que aplique el mismo `scope`, `authorize` y `mapError`. _(2.0.0: `routes(api, ctx)`; `additionalRoutes` sigue funcionando, deprecado)_
- [x] **Contexto compartido** `ctx` en handlers custom: `ctx.model`, `ctx.scope(req, action)`, `ctx.findOne(req)`, `ctx.list(req)`, `ctx.sanitize.filter/options/update` — para reutilizar el saneamiento sin reimplementarlo. _(2.0.0: `ctx.Model/where/find/load/list/sanitize/serialize`)_
- [x] **Override por verbo:** `handlers: { create: customFn }` o `methods: { create: false, update: { handler } }` para reemplazar solo un verbo conservando los otros cuatro. _(2.0.0: `handlers: { <verbo>: fn }`; conserva authorize + scope)_
- [x] **Recursos "compuestos":** poder declarar relaciones (`/orders/:id/lines`) como sub-recurso con su propio scope heredado del padre. _(2.0.0: resuelto como receta del README —`url` con params + `scope` del padre—, sin API dedicada: no ganaba capacidad)_
- [x] **Acciones no CRUD:** `actions: { close: { method: 'POST', url: '/:id/close', handler } }` que reciben el doc ya cargado y autorizado (patrón de `/order/:id/status`, `/purchase-order/:id/receive`, etc. en Igor). _(2.0.0: `actions`)_
- [x] **Serialización:** `serialize(doc, req)` por recurso (ocultar campos sensibles como email o teléfono sin `select` en cada query). _(2.0.0)_
- [x] **Hooks de lista:** `afterList(result, req)` para enriquecer/proyectar sin controlador aparte. _(2.0.0)_
- [x] **Sin controladores por default:** meta — que el 80 % de los recursos de Igor (catálogos con scope por restaurante) queden en ~5 líneas de configuración declarativa (`restaurantOwned('/table', TableModel, 'tables')` ya existe como helper en `routes.js`; debería ser una opción del plugin). _(2.0.0: resuelto como receta —la factory `owned(url, Model, extra)` vive en la app—; el tenant es del dominio, no del plugin)_

## 5. Plan de trabajo

**Fase 0 — Red de seguridad (antes de tocar nada)**
- [x] Tests de errores y seguridad: filtro con `$where`, regex malicioso, `limit` enorme, `populate` desde el cliente, mass assignment en PUT, bulk con hooks, E11000 sin filtrar detalle, ids inválidos. Hoy hay 5 casos felices (C16). _(2.0.0: 194 unitarios + 75 de integración)_
- [x] Correr la suite con Fastify 4 **y** 5 (CI matrix) y con Node LTS. _(2.0.0: Fastify 4 y 5 en la misma suite; **falta** la matriz de CI, ver §8)_
- [x] Arreglar README/ejemplos (C11, C17): documentar lo que el código realmente hace.

**Fase 1 — 1.9.x (parches seguros, sin romper)**
- [x] C6: `Model.create` en el bulk (o `bulk` opt-in), con `maxBulk`. _(entró directo en 2.0.0; no hubo 1.9.x)_
- [x] C7/C8: `mapError` por defecto con 400/404/409/500 sin detalles; `err.message` solo en log. _(2.0.0)_
- [x] C12: no pisar `opts.schema`; no pasar `opts` completo al DELETE. _(2.0.0)_
- [x] C14: tope configurable del bulk. _(2.0.0: `bulk.max`)_

**Fase 2 — 2.0.0 (seguro por defecto)**
- [x] `filter` con allowlist de operadores y regex escapado (C1, C2).
- [x] `limits` y `options` saneadas, sin `pagination:false` por default (C3).
- [x] `fields.writable/readonly` y descarte de `_id`/timestamps (C5).
- [x] `methods` por recurso (C10).
- [x] Hooks `scope`, `authorize`, `before*/after*`, `mapError` (C4, C9).
- [x] `fastify-plugin` y `req.crudify` (C15). _(2.0.0: `req.crudify` sí; `fastify-plugin` **no**: un plugin sin `fp` ya hereda hooks y decoradores del padre y `fp` rompería `prefix` —C25—)_
- [x] Guía de migración 1.x → 2.0 con lista de cambios de comportamiento. _(CHANGELOG.md)_

**Fase 3 — Extensibilidad (§4)**
- [x] API `routes`/`actions`, `ctx` compartido y override por verbo.
- [x] `serialize`, `afterList`, sub-recursos. _(los sub-recursos quedaron como receta, ver §4)_
- [ ] Migrar Igor a Crudify 2.0 como validación: reemplazar `scopedCrud.js` + `resourceScopes.js` + `querySanitizer.js` por configuración y comprobar que los 154 tests de Igor y los casos de `todo.md` pasan.

## 6. Criterios de aceptación

- [x] El núcleo cabe en ≈ 300 líneas, sin dependencias nuevas obligatorias. _(crudify.js: 341 líneas, tope del plan 360; sanitizer.js: 264; cero dependencias de runtime)_
- [x] Un recurso con scope por tenant se declara en ≤ 10 líneas y **no** permite ver/editar/borrar documentos de otro tenant (prueba automatizada con dos tenants). _(`test/integration/crudify.test.js` "tenant isolation" y `example/app.js`)_
- [x] Ningún error devuelve `err.message` crudo de Mongo; duplicados → 409 genérico.
- [x] Los hooks de `save` corren en POST unitario y en bulk.
- [x] Un endpoint custom (acción no CRUD) comparte scope/permisos/errores sin código duplicado (ejemplo `POST /:id/close` en el README).
- [x] Suite verde en Fastify 4 y 5; README y `example/` ejecutables tal cual.
- [ ] Igor corre sobre Crudify 2.0 sin `scopedCrud.js` propio.

## 7. Notas

- **Compatibilidad con Igor hoy:** las URLs y la forma de respuesta (`{ docs, totalDocs, ... }`; 404 `{ status, error, message }`) son contrato de los clientes (`igor-admin`, `igor-users`); mantenerlas en 2.0 o versionarlas.
- **Cosas de Igor que NO deben entrar al plugin** (siguen siendo del dominio): Casbin, JWT/blacklist, auditoría y reglas de negocio de órdenes/ventas. El plugin solo ofrece los puntos de enganche.
- Referencias en Igor: `igor-server/src/plugins/scopedCrud.js`, `tenancy/resourceScopes.js`, `utils/querySanitizer.js`, `utils/mongoErrors.js`, `plugins/duplicateKeyGuard.js`, `analysis.md` (H-03, N-14, N-15).

## 8. Pendientes tras 2.0.0 (requieren decisión o acción tuya)

- [ ] **Publicar 2.0.0.** No se publicó nada ni se hizo commit/push. Ojo: `publish.yml` publica en cada push a `master` y sube la versión con `[major]/[minor]/[patch]` en el mensaje del commit (`iuccio/npm-semver-publish-action`); `package.json` ya dice `2.0.0`, así que decide si el action debe respetarla o dejar que la calcule, para no terminar en 3.0.0.
- [ ] **CI (C23).** `.github/workflows` no se tocó (no estaba aprobado): `publish.yml` no corre tests antes de publicar; `test.yml` no tiene matriz de Node 22/24 ni caché de `~/.cache/mongodb-binaries`. En CI no hace falta `MONGOMS_SYSTEM_BINARY` (descarga Mongo 7.0.14).
- [ ] **Tipos `.d.ts`** (opciones, hooks, `ctx`, `CrudifyError`): un tercer archivo; propuesto para 2.1.
- [ ] **`query.maxPage`** (un `page` enorme produce un `skip` caro) y paginación por cursor.
- [ ] **Migrar Igor a Crudify 2.0** como validación real: reemplazar `scopedCrud.js`, `resourceScopes.js` y `querySanitizer.js` por configuración y correr sus 154 tests y los casos de `todo.md`. Diferencias a tener en cuenta: Igor usaba `limit` 1000 en catálogos (`query.maxLimit`), mensajes de hooks de modelo visibles al cliente (ahora `CrudifyError` o `mapError`), `bulk` máximo 100, y la forma del 409 (`code: 'duplicate_key'`, mensaje en inglés).
- [ ] Quitar `additionalRoutes` en 3.0.
- [ ] Mongoose 9 queda fuera (peer `^8`).
- [ ] Bulk no transaccional: un E11000 a mitad del lote deja inserciones parciales (igual que en 1.x). Documentar o usar transacciones en una versión futura.
- [ ] `lean: true` por recurso no ejecuta getters, virtuals ni transforms de `toJSON`; revisar antes de activarlo donde esos transforms oculten secretos.
- [ ] Corrección al análisis original: C15 decía que sin `fastify-plugin` se perdía la herencia de hooks; no es así (C25). Un plugin encapsulado hereda los hooks y decoradores del padre.
