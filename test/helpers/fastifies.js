import Fastify5 from 'fastify'
import Fastify4 from 'fastify4'

// Every suite runs against both supported Fastify majors.
export const FASTIFIES = [['fastify@4', Fastify4], ['fastify@5', Fastify5]]
