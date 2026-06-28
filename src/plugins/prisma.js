// src/plugins/prisma.js
// ─────────────────────────────────────────────────────────────────────────────
// PRISMA FASTIFY PLUGIN
//
// Registers a single PrismaClient on app.prisma and exposes a tenant-scoped
// helper: request.db
//
// The key technique: every request that has been authenticated by the API key
// middleware gets a "scoped" Prisma client that:
//   1. Sets the Postgres session variable `app.org_id` before any query
//   2. This activates the RLS policies defined in rls.sql
//   3. All queries through request.db are automatically filtered to that tenant
//
// Usage in route handlers:
//   const logs = await request.db.callLog.findMany()  // only this org's rows
// ─────────────────────────────────────────────────────────────────────────────

import fp           from 'fastify-plugin';
import { PrismaClient } from '@prisma/client';

// Single shared client — Prisma manages the connection pool internally
const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development'
    ? [{ emit: 'event', level: 'query' }]
    : ['error'],
});

async function prismaPlugin(app) {
  // Attach the raw client for admin/internal routes
  app.decorate('prisma', prisma);

  // Decorate requests with a lazy getter for the tenant-scoped client.
  // The getter is populated by apiKeyMiddleware once organizationId is known.
  app.decorateRequest('db', null);

  app.addHook('onClose', async () => {
    await prisma.$disconnect();
  });
}

export default fp(prismaPlugin, { name: 'prisma' });

// ─────────────────────────────────────────────────────────────────────────────
// createScopedClient — called by the API key middleware after auth succeeds.
// Returns a Prisma client whose every transaction opens with SET LOCAL app.org_id.
//
// This is the core of the RLS activation pattern.
// ─────────────────────────────────────────────────────────────────────────────
export function createScopedClient(organizationId) {
  return prisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          // Wrap every Prisma operation in a transaction that first sets the
          // Postgres session variable. SET LOCAL scopes it to this transaction only.
          const [, result] = await prisma.$transaction([
            prisma.$executeRawUnsafe(
              `SET LOCAL app.org_id = '${organizationId.replace(/'/g, "''")}'`
            ),
            query(args),
          ]);
          return result;
        },
      },
    },
  });
}
