// src/server.js
// ─────────────────────────────────────────────────────────────────────────────
// FASTIFY SERVER — SaaS Platform Entry Point (Phase 2)
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import Fastify      from 'fastify';
import cors         from '@fastify/cors';
import rateLimit    from '@fastify/rate-limit';
import websocket    from '@fastify/websocket';
import prismaPlugin from './plugins/prisma.js';
import chatRoutes      from './routes/chat.js';
import apiKeyRoutes    from './routes/api-keys.js';
import vapiWebhook     from './routes/webhooks/vapi.js';
import chatRuleRoutes  from './routes/admin/chat-rules.js';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const ENV  = process.env.NODE_ENV ?? 'development';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    ...(ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } }
      : {}),
  },
  // Expose raw body for Vapi webhook signature verification
  addContentTypeParser: false,
});

// ── Raw body capture for webhook signature verification ───────────────────────
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
  req.rawBody = body.toString();
  try { done(null, JSON.parse(req.rawBody)); }
  catch (e) { done(e); }
});

// ── Plugins ───────────────────────────────────────────────────────────────────
await app.register(prismaPlugin);
await app.register(websocket);

await app.register(cors, {
origin: ENV === 'production' 
    ? 'https://chatai-orpin-kappa.vercel.app' 
    : true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
});

await app.register(rateLimit, {
  global:  true,
  max:     200,          // global: 200 req/min per IP
  timeWindow: '1 minute',
  keyGenerator: (request) =>
    request.organizationId   // per-org rate limit once auth resolves
    ?? request.ip,
});

// ── Routes ────────────────────────────────────────────────────────────────────
await app.register(chatRoutes);
await app.register(apiKeyRoutes);
await app.register(chatRuleRoutes);   // ← admin CRUD for ChatRule model
await app.register(vapiWebhook, { prefix: '/webhooks' });

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', async () => ({
  status:    'ok',
  env:       ENV,
  timestamp: new Date().toISOString(),
}));

// ── Boot ──────────────────────────────────────────────────────────────────────

// 1. Local Development
if (process.env.NODE_ENV !== 'production') {
  try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
    app.log.info(`🚀 SaaS Platform ready — port ${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// 2. Vercel Serverless Function Handler
export default async function handler(req, res) {
  await app.ready();
  app.server.emit('request', req, res);
}
