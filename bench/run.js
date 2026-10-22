// Micro-benchmarks, no extra dependencies: node bench/run.js
// 1) sanitizer cost per call  2) plugin overhead versus a bare Fastify route.
import { performance } from 'node:perf_hooks'
import Fastify from 'fastify'
import mongoose from 'mongoose'
import paginate from 'mongoose-paginate-v2'
import { Crudify, createSanitizer, sanitizeFilter, sanitizeOptions, sanitizeUpdate } from '../crudify.js'

const measure = async (label, iterations, fn) => {
  for (let i = 0; i < Math.min(iterations, 2000); i++) await fn() // warm-up
  const started = performance.now()
  for (let i = 0; i < iterations; i++) await fn()
  const micros = ((performance.now() - started) * 1000) / iterations
  console.log(`${label.padEnd(58)} ${micros.toFixed(2).padStart(9)} µs/op  ${Math.round(1e6 / micros).toLocaleString().padStart(11)} ops/s`)
  return micros
}

console.log('— sanitizer —')
const typical = { status: 'open', n: { $gte: 1, $lt: 9 }, tag: { $in: ['a', 'b', 'c'] }, name: '/ana/', $or: [{ a: 1 }, { b: 2 }] }
const wide = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field${i}`, i]))
const tooWide = { ...wide, extra: 1 }
const update20 = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, `value ${i}`]))
const compiled = createSanitizer()

await measure('filter, typical (5 keys, $in, $or, /text/)', 200_000, () => sanitizeFilter(typical))
await measure('filter, 100 keys (the maximum)', 50_000, () => sanitizeFilter(wide))
await measure('filter, 101 keys (rejected with a 400)', 50_000, () => { try { sanitizeFilter(tooWide) } catch {} })
await measure('options, page/limit/sort', 200_000, () => sanitizeOptions({ page: 2, limit: 30, sort: '-createdAt name' }))
await measure('update, 20 fields', 100_000, () => sanitizeUpdate(update20))
await measure('compile a sanitizer (what NOT to do per request)', 20_000, () => createSanitizer({ maxLimit: 50 }))
await measure('precompiled filter (what Crudify does)', 200_000, () => compiled.filter(typical))

console.log('\n— plugin overhead (app.inject, stubbed model, same work in both routes) —')
const schema = new mongoose.Schema({ name: String })
schema.plugin(paginate)
const Model = mongoose.model('Bench', schema)
const doc = { _id: '64b7f0a2c3d4e5f607182930', name: 'bench' }
Model.findOne = async () => doc
Model.paginate = async () => ({ docs: [doc], totalDocs: 1, limit: 50, page: 1 })

const app = Fastify()
app.register(Crudify, { url: '/crud', Model, scope: false })
app.get('/bare/:id', async (req) => Model.findOne({ _id: req.params.id }))
app.get('/bare', async () => Model.paginate({}, { page: 1, limit: 50, pagination: true }))
await app.ready()
const hit = (url) => () => app.inject({ method: 'GET', url })
const id = doc._id

const iterations = 30_000
const results = {}
for (const [name, bare, crud] of [['GET /:id', `/bare/${id}`, `/crud/${id}`], ['GET /', '/bare', '/crud']]) {
  // interleave a few rounds so JIT / GC noise hits both equally
  const bareTimes = []
  const crudTimes = []
  for (let round = 0; round < 3; round++) {
    bareTimes.push(await measure(`${name} bare Fastify route (round ${round + 1})`, iterations, hit(bare)))
    crudTimes.push(await measure(`${name} Crudify (round ${round + 1})`, iterations, hit(crud)))
  }
  const best = (xs) => Math.min(...xs)
  results[name] = { bare: best(bareTimes), crud: best(crudTimes) }
}
console.log('\n— summary (best of 3 rounds) —')
for (const [name, { bare, crud }] of Object.entries(results)) {
  console.log(`${name.padEnd(10)} bare ${bare.toFixed(1)} µs · Crudify ${crud.toFixed(1)} µs · overhead ${(((crud - bare) / bare) * 100).toFixed(1)} % (+${(crud - bare).toFixed(1)} µs)`)
}
await app.close()
