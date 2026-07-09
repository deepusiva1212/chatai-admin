// src/server.js
import 'dotenv/config';
import Fastify         from 'fastify';
import prismaPlugin    from './plugins/prisma.js';
import chatRoutes      from './routes/chat.js';
import apiKeyRoutes    from './routes/api-keys.js';
import vapiWebhook     from './routes/webhooks/vapi.js';
import chatRuleRoutes  from './routes/admin/chat-rules.js';

const ENV = process.env.NODE_ENV ?? 'development';
const PORT = parseInt(process.env.PORT ?? '3001', 10);

// ── The ONE frontend URL allowed to call this backend ─────────────────────────
// Add more origins here if you ever have a second frontend domain.
const ALLOWED_ORIGINS = [
  'https://chatai-orpin-kappa.vercel.app',
  'http://localhost:5173',   // local dev
  'http://localhost:5174',
  'http://localhost:5175',
];

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    ...(ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  },
});

// ── Raw body capture (needed for Vapi webhook HMAC verification) ──────────────
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
  req.rawBody = body.toString();
  try   { done(null, JSON.parse(req.rawBody)); }
  catch (e) { done(e); }
});

// ── CORS — handled manually so it works reliably on Vercel serverless ─────────
//
// Why not @fastify/cors?
//   On Vercel, the serverless function cold-start means plugin hooks sometimes
//   don't execute before the edge network returns the OPTIONS preflight response.
//   Manually setting headers in an onRequest hook fires FIRST, every time.
//
// Why not credentials: true with wildcard?
//   Browsers reject wildcard (*) origins when credentials are included.
//   We must echo back the exact requesting origin if it is on our allow-list.
//
app.addHook('onRequest', async (request, reply) => {
  const origin = request.headers['origin'];

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    // Echo back the exact origin — required when credentials: true
    reply.header('Access-Control-Allow-Origin',      origin);
    reply.header('Access-Control-Allow-Credentials', 'true');
    reply.header('Access-Control-Allow-Methods',     'GET, POST, PUT, DELETE, OPTIONS');
    reply.header('Access-Control-Allow-Headers',     'Content-Type, x-api-key, x-admin-secret, Authorization');
    reply.header('Access-Control-Max-Age',           '86400'); // cache preflight 24h
  }

  // Handle OPTIONS preflight immediately — do NOT pass to route handlers
  if (request.method === 'OPTIONS') {
    reply.code(204).send();
  }
});

// ── Plugins ───────────────────────────────────────────────────────────────────
await app.register(prismaPlugin);

// ── Routes ────────────────────────────────────────────────────────────────────
await app.register(chatRoutes);
await app.register(apiKeyRoutes);
await app.register(chatRuleRoutes);
await app.register(vapiWebhook, { prefix: '/webhooks' });

// ── Health check (useful to verify the backend is alive) ──────────────────────
app.get('/health', async () => ({
  status:    'ok',
  env:       ENV,
  timestamp: new Date().toISOString(),
}));

// ── Local development: start listening ───────────────────────────────────────
if (ENV !== 'production') {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`Backend ready on http://localhost:${PORT}`);
}

// ── Vercel serverless export ──────────────────────────────────────────────────
export default async function handler(req, res) {
  await app.ready();
  app.server.emit('request', req, res);
}
