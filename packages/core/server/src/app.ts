// DOCUMENTED
import { parse, stringify } from 'flatted'
import { authenticate } from '@feathersjs/authentication'
import { NotAuthenticated } from '@feathersjs/errors/lib'
import { HookContext } from '@feathersjs/feathers'
import { feathers } from '@feathersjs/feathers/lib'
import {
  bodyParser,
  cors,
  errorHandler,
  koa,
  parseAuthentication,
  rest,
} from '@feathersjs/koa'
import socketio from '@feathersjs/socketio'
import { RedisPubSub } from '@magickml/redis-pubsub'
import sync from 'feathers-sync'
import { configureManager, globalsManager } from '@magickml/core'

import { REDISCLOUD_URL } from '@magickml/config'

import { dbClient } from './dbClient'
import type { Application } from './declarations'
import { logError } from './hooks'
import channels from './sockets/channels'
import { authentication } from './auth/authentication'
import { services } from './services'
import handleSockets from './sockets/sockets'

//Vector DB Related Imports
import { PostgresVectorStoreCustom, ExtendedEmbeddings } from './vectordb'
import { PluginEmbeddings } from './customEmbeddings'

import { getLogger } from '@magickml/core'

// Initialize the Feathers Koa app
export const app: Application = koa(feathers())

declare module './declarations' {
  interface Configuration {
    vectordb: PostgresVectorStoreCustom | any
    docdb: PostgresVectorStoreCustom | any
    pubsub: RedisPubSub
    isAgent?: boolean
  }
}

export async function initApp() {
  const logger = getLogger()
  logger.info('Initializing feathers app...')
  globalsManager.register('feathers', app)

  const port = parseInt(process.env.PORT || '3030', 10)
  app.set('port', port)
  const host = process.env.HOST || 'localhost'
  app.set('host', host)
  const paginateDefault = parseInt(process.env.PAGINATE_DEFAULT || '10', 10)
  const paginateMax = parseInt(process.env.PAGINATE_MAX || '50', 10)
  const paginate = {
    default: paginateDefault,
    max: paginateMax,
  }
  app.set('paginate', paginate)

  // Koa middleware
  app.use(cors({ origin: '*' }))
  app.use(errorHandler())
  app.use(parseAuthentication())
  app.use(bodyParser({ jsonLimit: '50mb', formLimit: '50mb', multipart: true }))

  // Initialize pubsub redis client
  const pubsub = new RedisPubSub()
  // sync up messages between the app and the runner
  logger.debug('checking for REDISCLOUD_URL')
  if (REDISCLOUD_URL) {
    logger.info('SETTING UP REDIS')
    app.configure(
      sync({
        uri: REDISCLOUD_URL,
        serialize: stringify,
        deserialize: parse,
      })
    )

    await pubsub.initialize({
      url: REDISCLOUD_URL,
    })

    app.set('pubsub', pubsub)
  }

  // Configure app spell management settings
  app.configure(configureManager())

  // Configure authentication
  app.set('authentication', {
    secret: process.env.JWT_SECRET || 'secret',
    entity: null,
    authStrategies: ['jwt'],
    jwtOptions: {
      header: { type: 'access' },
      audience: 'https://yourdomain.com',
      issuer: 'feathers',
      algorithm: 'A256GCM',
      expiresIn: '1d',
    },
  })

  app.configure(authentication)

  // Configure WebSocket for the app
  app.configure(
    socketio(
      {
        cors: {
          origin: '*',
          methods: ['GET', 'POST', 'OPTIONS'],
          allowedHeaders: ['Authorization'],
          credentials: true,
        },
      },
      handleSockets(app)
    )
  )

  // Configure services and transports
  app.configure(rest())

  app.configure(dbClient)
  const embeddings = new PluginEmbeddings({}) as unknown as ExtendedEmbeddings
  const vectordb = new PostgresVectorStoreCustom(embeddings, {
    client: app.get('dbClient'),
    tableName: 'events',
    queryName: 'match_events',
  })
  const docdb = new PostgresVectorStoreCustom(embeddings, {
    client: app.get('dbClient'),
    tableName: 'documents',
    queryName: 'match_documents',
  })
  app.set('vectordb', vectordb)
  app.set('docdb', docdb)
  app.configure(services)
  app.configure(channels)

  // Register hooks
  app.hooks({
    around: {
      all: [
        logError,
        async (context: HookContext, next) => {
          // if the route is to the api service, skip auth
          if (context.path === 'api') {
            return next()
          }

          if (context.path !== 'authentication') {
            return authenticate('jwt')(context, next)
          }
        },
        async (context: HookContext, next) => {
          const { params } = context

          const { authentication, authenticated } = params

          if (authenticated) {
            context.params.user = authentication.payload.user
            context.params.projectId = authentication.payload.projectId

            if (context?.params?.query?.projectId) {
              const projectId = context.params.query.projectId

              if (authentication.payload.project !== projectId) {
                throw new NotAuthenticated(
                  'User not authorized to access project'
                )
              }
            }
          }

          return next()
        },
      ],
    },
    before: {
      all: [],
    },
    after: {},
    error: {},
  })

  // Register setup and teardown hooks
  app.hooks({
    setup: [],
    teardown: [],
  })
  logger.info('Feathers app initialized')
}
