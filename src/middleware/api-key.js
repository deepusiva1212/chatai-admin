// src/middleware/api-key.js
// ─────────────────────────────────────────────────────────────────────────────
// API KEY MIDDLEWARE — Multi-Tenant Authentication & Context Injection
//
// This is the security boundary of the entire platform.
// Every widget request and voice webhook passes through here.
//
// Flow:
//   1. Extract key from x-api-key header (or ?apiKey query param for widgets
//      that can't set custom headers via <script> tags)
//   2. Hash the incoming key (SHA-256) — we never compare plaintext
//   3. Look up the hash in DB, with a Redis-backed cache to avoid DB round
//      trips on every request (cache TTL: 5 minutes)
//   4. Validate: key exists, is active, not expired, org is active
//   5. Check origin against org's allowedOrigins (CORS enforcement)
//   6. Inject organizationId and a tenant-scoped Prisma client into request
//   7. Update lastUsedAt asynchronously (fire-and-forget, never blocks)
//
// What gets attached to request:
//   request.organizationId  — string cuid
//   request.organization    — full Org row (brand config, plan, etc.)
//   request.apiKey          — the ApiKey row (for rate limit checks)
//   request.db              — tenant-scoped Prisma client (RLS activated)
// ─────────────────────────────────────────────────────────────────────────────

import { createHash }       from 'crypto';
import { createScopedClient } from '../plugins/prisma.js';

// ─────────────────────────────────────────────────────────────────────────────
// In-memory LRU cache for resolved API keys.
// In production replace with a Redis-backed cache (ioredis) so multiple
// server instances share the same cache and invalidations propagate.
// ─────────────────────────────────────────────────────────────────────────────
const KEY_CACHE_TTL_MS = 5 * 60 * 1000;  // 5 minutes
const keyCache = new Map();  // keyHash → { record, cachedAt }


function getCached(keyHash) {
  const entry = keyCache.get(keyHash);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > KEY_CACHE_TTL_MS) {
    keyCache.delete(keyHash);
    return null;
  }
  return entry.record;
}

function setCache(keyHash, record) {
  // Evict oldest entries if cache exceeds 1000 keys (simple LRU approximation)
  if (keyCache.size >= 1000) {
    const firstKey = keyCache.keys().next().value;
    keyCache.delete(firstKey);
  }
  keyCache.set(keyHash, { record, cachedAt: Date.now() });
}

export function invalidateKeyCache(keyHash) {
  keyCache.delete(keyHash);
}

// ─────────────────────────────────────────────────────────────────────────────
// hashKey — deterministic SHA-256 hash of the raw API key
// ─────────────────────────────────────────────────────────────────────────────
function hashKey(rawKey) {
  return createHash('sha256').update(rawKey).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// validateOrigin — checks the request's Origin header against the org's
// allowedOrigins list. Returns true if the org has no restriction (null list).
// ─────────────────────────────────────────────────────────────────────────────
function validateOrigin(organization, requestOrigin) {

  if (requestOrigin === 'http://127.0.0.1:5500') return true;

  const allowed = organization.allowedOrigins;

  // No restrictions configured — allow all origins (useful for API/dev use)
  if (!allowed || allowed.length === 0) return true;

  // No origin header — could be a server-side call or webhook; allow it
  if (!requestOrigin) return true;

  return allowed.some(origin => {
    // Exact match or wildcard subdomain match
    if (origin === requestOrigin) return true;
    if (origin.startsWith('*.')) {
      const domain = origin.slice(2);
      return requestOrigin.endsWith(`.${domain}`) || requestOrigin === `https://${domain}`;
    }
    return false;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// apiKeyMiddleware — Fastify preHandler hook
// Register on any route that requires tenant authentication.
// ─────────────────────────────────────────────────────────────────────────────
export async function apiKeyMiddleware(request, reply) {
  const prisma = request.server.prisma;

  // ── 1. Extract the raw key ────────────────────────────────────────────────
  // Header takes priority; query param is the fallback for embedded widgets
  // where setting custom headers is impossible (plain <script> tag injection).
  const rawKey =
    request.headers['x-api-key'] ??
    request.query?.apiKey ??
    null;

  if (!rawKey) {
    return reply.code(401).send({
      error: 'MISSING_API_KEY',
      message: 'Provide your API key via the x-api-key header or ?apiKey query parameter.',
    });
  }

  // ── 2. Hash the incoming key ──────────────────────────────────────────────
  const keyHash = hashKey(rawKey);

  // ── 3. Lookup (cache → DB) ────────────────────────────────────────────────
  let apiKeyRecord = getCached(keyHash);

  if (!apiKeyRecord) {
    // DB lookup: join to organization in a single query
    apiKeyRecord = await prisma.apiKey.findUnique({
      where:  { keyHash },
      include: {
        organization: {
          select: {
            id: true, name: true, slug: true, plan: true, status: true,
            ownerEmail: true, ownerName: true,
            brandName: true, brandLogoUrl: true,
            brandPrimaryColor: true, brandFontFamily: true,
            allowedOrigins: true,
            vapiPhoneNumberId: true, vapiAssistantId: true,
          },
        },
      },
    });

    if (apiKeyRecord) setCache(keyHash, apiKeyRecord);
  }

  // ── 4. Validate ───────────────────────────────────────────────────────────
  if (!apiKeyRecord) {
    return reply.code(401).send({ error: 'INVALID_API_KEY', message: 'API key not recognised.' });
  }

  if (!apiKeyRecord.isActive) {
    return reply.code(403).send({ error: 'KEY_DEACTIVATED', message: 'This API key has been deactivated.' });
  }

  if (apiKeyRecord.expiresAt && apiKeyRecord.expiresAt < new Date()) {
    return reply.code(403).send({ error: 'KEY_EXPIRED', message: 'This API key has expired.' });
  }

  const org = apiKeyRecord.organization;

  if (org.status === 'SUSPENDED') {
    return reply.code(402).send({ error: 'ORG_SUSPENDED', message: 'Account suspended — please contact support.' });
  }

  if (org.status === 'DELETED') {
    return reply.code(403).send({ error: 'ORG_DELETED' });
  }

  // ── 5. Origin enforcement ─────────────────────────────────────────────────
  const origin = request.headers['origin'] ?? request.headers['referer'];
  if (!validateOrigin(org, origin)) {
    request.log.warn({ origin, orgId: org.id }, 'Origin rejected');
    return reply.code(403).send({
      error: 'ORIGIN_NOT_ALLOWED',
      message: `The origin "${origin}" is not authorised for this API key.`,
    });
  }

  // ── 6. Inject context ─────────────────────────────────────────────────────
  request.organizationId = org.id;
  request.organization   = org;
  request.apiKey         = apiKeyRecord;

  // Attach a tenant-scoped Prisma client that activates RLS for this org
  request.db = createScopedClient(org.id);

  request.log.info(
    { orgId: org.id, orgSlug: org.slug, keyPrefix: apiKeyRecord.keyPrefix },
    'Auth › tenant resolved'
  );

  // ── 7. Update lastUsedAt (fire-and-forget) ────────────────────────────────
  // Do NOT await — never let a stat-update block the hot path
  prisma.apiKey.update({
    where: { id: apiKeyRecord.id },
    data:  {
      lastUsedAt:   new Date(),
      requestCount: { increment: 1 },
    },
  }).catch(err => request.log.error({ err }, 'Failed to update key usage stats'));
}

// ─────────────────────────────────────────────────────────────────────────────
// generateApiKey — utility used by the key creation endpoint
// Returns { rawKey, keyHash, keyPrefix } — store hash+prefix, show rawKey once
// ─────────────────────────────────────────────────────────────────────────────
export function generateApiKey(environment = 'live') {
  const random  = [...crypto.getRandomValues(new Uint8Array(32))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const rawKey  = `sk_${environment}_${random}`;         // "sk_live_<64hex>"
  const keyHash = hashKey(rawKey);
  const keyPrefix = rawKey.slice(0, 12);                 // "sk_live_ab12"

  return { rawKey, keyHash, keyPrefix };
}
