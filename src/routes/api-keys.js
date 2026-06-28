// src/routes/api-keys.js
// ─────────────────────────────────────────────────────────────────────────────
// API KEY MANAGEMENT ROUTES
// Used by the white-label dashboard to create, list, and revoke tenant keys.
//
// These routes use a different auth mechanism (admin session token / JWT)
// since there's no API key yet when you're creating one.
// For Phase 2 simplicity, we use a shared ADMIN_SECRET header.
// ─────────────────────────────────────────────────────────────────────────────

import { generateApiKey, invalidateKeyCache } from '../middleware/api-key.js';

// Simple admin auth guard — replace with proper JWT in production
async function adminAuthHook(request, reply) {
  const secret = request.headers['x-admin-secret'];
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return reply.code(401).send({ error: 'UNAUTHORIZED' });
  }
}

export default async function apiKeyRoutes(app) {

  // ── POST /admin/organizations/:orgId/api-keys ──────────────────────────────
  app.post('/admin/organizations/:orgId/api-keys', {
    preHandler: [adminAuthHook],
  }, async (request, reply) => {
    const { orgId }  = request.params;
    const { name, expiresAt, rateLimit, environment = 'live' } = request.body;
    const prisma = request.server.prisma;

    // Verify org exists
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return reply.code(404).send({ error: 'ORG_NOT_FOUND' });

    // Enforce plan limits on key count
    const keyCount = await prisma.apiKey.count({ where: { organizationId: orgId, isActive: true } });
    const limits   = { STARTER: 1, GROWTH: 5, ENTERPRISE: Infinity };
    if (keyCount >= limits[org.plan]) {
      return reply.code(403).send({
        error:   'PLAN_LIMIT_REACHED',
        message: `Your ${org.plan} plan allows a maximum of ${limits[org.plan]} active API key(s).`,
      });
    }

    const { rawKey, keyHash, keyPrefix } = generateApiKey(environment);

    const apiKey = await prisma.apiKey.create({
      data: {
        organizationId: orgId,
        name:           name ?? `Key ${keyCount + 1}`,
        keyPrefix,
        keyHash,
        isActive:       true,
        expiresAt:      expiresAt ? new Date(expiresAt) : null,
        rateLimit:      rateLimit ?? 1000,
      },
    });

    // Return the raw key ONCE — it will never be retrievable again
    return reply.code(201).send({
      id:         apiKey.id,
      name:       apiKey.name,
      keyPrefix,
      // rawKey is shown exactly once. Store it securely — we only store the hash.
      rawKey,
      createdAt:  apiKey.createdAt,
      expiresAt:  apiKey.expiresAt,
    });
  });

  // ── GET /admin/organizations/:orgId/api-keys ───────────────────────────────
  app.get('/admin/organizations/:orgId/api-keys', {
    preHandler: [adminAuthHook],
  }, async (request, reply) => {
    const { orgId } = request.params;
    const prisma    = request.server.prisma;

    const keys = await prisma.apiKey.findMany({
      where:   { organizationId: orgId },
      select:  {
        id: true, name: true, keyPrefix: true, isActive: true,
        createdAt: true, lastUsedAt: true, expiresAt: true, requestCount: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // Never return keyHash in listings
    return { keys };
  });

  // ── DELETE /admin/api-keys/:keyId ──────────────────────────────────────────
  app.delete('/admin/api-keys/:keyId', {
    preHandler: [adminAuthHook],
  }, async (request, reply) => {
    const { keyId } = request.params;
    const prisma    = request.server.prisma;

    const key = await prisma.apiKey.update({
      where: { id: keyId },
      data:  { isActive: false },
    });

    // Evict from cache immediately so revocation takes effect right away
    invalidateKeyCache(key.keyHash);

    return { revoked: true, keyId };
  });
}
