// src/routes/admin/chat-rules.js
// ─────────────────────────────────────────────────────────────────────────────
// CHAT RULE ADMIN ROUTES
//
// All routes require the x-admin-secret header (same guard used in api-keys.js).
// All data is scoped to a single organizationId from the URL param.
//
// Endpoints:
//   GET    /admin/organizations/:orgId/chat-rules          list all rules
//   POST   /admin/organizations/:orgId/chat-rules          create rule
//   PUT    /admin/organizations/:orgId/chat-rules/:ruleId  update rule
//   DELETE /admin/organizations/:orgId/chat-rules/:ruleId  delete rule
//   POST   /admin/organizations/:orgId/chat-rules/test     test message against rules
// ─────────────────────────────────────────────────────────────────────────────

import { tryCaptureName, matchRules, FALLBACK_MESSAGE } from '../../services/rule-engine.js';

// ── Simple admin auth guard ───────────────────────────────────────────────────
async function adminAuth(request, reply) {
  const secret = request.headers['x-admin-secret'];
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return reply.code(401).send({ error: 'UNAUTHORIZED' });
  }
}

// ── Shared body schema for create / update ────────────────────────────────────
const ruleBodySchema = {
  type: 'object',
  required: ['label', 'keywords', 'replyText'],
  properties: {
    label:      { type: 'string', minLength: 1, maxLength: 120 },
    keywords:   { type: 'string', minLength: 1, maxLength: 1000 },
    replyText:  { type: 'string', minLength: 1, maxLength: 4000 },
    exactMatch: { type: 'boolean' },
    priority:   { type: 'integer', minimum: 0, maximum: 999 },
    isActive:   { type: 'boolean' },
  },
};

export default async function chatRuleRoutes(app) {

  // ── GET /admin/organizations/:orgId/chat-rules ────────────────────────────
  app.get('/admin/organizations/:orgId/chat-rules', {
    preHandler: [adminAuth],
  }, async (request, reply) => {
    const { orgId } = request.params;
    const prisma    = request.server.prisma;

    // Confirm org exists before querying (avoids leaking org existence info
    // to authed-but-wrong-org callers via empty vs 404 distinction)
    const org = await prisma.organization.findUnique({
      where:  { id: orgId },
      select: { id: true },
    });
    if (!org) return reply.code(404).send({ error: 'ORG_NOT_FOUND' });

    const rules = await prisma.chatRule.findMany({
      where:   { organizationId: orgId },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });

    return { rules, total: rules.length };
  });

  // ── POST /admin/organizations/:orgId/chat-rules ───────────────────────────
  app.post('/admin/organizations/:orgId/chat-rules', {
    preHandler: [adminAuth],
    schema:     { body: ruleBodySchema },
  }, async (request, reply) => {
    const { orgId } = request.params;
    const prisma    = request.server.prisma;
    const {
      label, keywords, replyText,
      exactMatch = false,
      priority   = 0,
      isActive   = true,
    } = request.body;

    const org = await prisma.organization.findUnique({
      where: { id: orgId }, select: { id: true },
    });
    if (!org) return reply.code(404).send({ error: 'ORG_NOT_FOUND' });

    // Normalise keywords: trim each token, remove blanks, rejoin
    const normalisedKeywords = keywords
      .split(',')
      .map(k => k.trim())
      .filter(k => k.length > 0)
      .join(', ');

    const rule = await prisma.chatRule.create({
      data: {
        organizationId: orgId,
        label,
        keywords: normalisedKeywords,
        replyText,
        exactMatch,
        priority,
        isActive,
      },
    });

    request.log.info({ ruleId: rule.id, orgId }, 'ChatRule created');
    return reply.code(201).send({ rule });
  });

  // ── PUT /admin/organizations/:orgId/chat-rules/:ruleId ────────────────────
  app.put('/admin/organizations/:orgId/chat-rules/:ruleId', {
    preHandler: [adminAuth],
    schema: {
      body: {
        // All fields optional on update
        type: 'object',
        properties: ruleBodySchema.properties,
      },
    },
  }, async (request, reply) => {
    const { orgId, ruleId } = request.params;
    const prisma            = request.server.prisma;

    // Verify the rule belongs to this org (prevents cross-tenant updates)
    const existing = await prisma.chatRule.findFirst({
      where: { id: ruleId, organizationId: orgId },
    });
    if (!existing) return reply.code(404).send({ error: 'RULE_NOT_FOUND' });

    // Build update payload from only the fields that were provided
    const updateData = {};
    const body = request.body;

    if (body.label      !== undefined) updateData.label      = body.label;
    if (body.replyText  !== undefined) updateData.replyText  = body.replyText;
    if (body.exactMatch !== undefined) updateData.exactMatch = body.exactMatch;
    if (body.priority   !== undefined) updateData.priority   = body.priority;
    if (body.isActive   !== undefined) updateData.isActive   = body.isActive;
    if (body.keywords   !== undefined) {
      updateData.keywords = body.keywords
        .split(',').map(k => k.trim()).filter(k => k.length > 0).join(', ');
    }

    const rule = await prisma.chatRule.update({
      where: { id: ruleId },
      data:  updateData,
    });

    request.log.info({ ruleId, orgId }, 'ChatRule updated');
    return { rule };
  });

  // ── DELETE /admin/organizations/:orgId/chat-rules/:ruleId ─────────────────
  app.delete('/admin/organizations/:orgId/chat-rules/:ruleId', {
    preHandler: [adminAuth],
  }, async (request, reply) => {
    const { orgId, ruleId } = request.params;
    const prisma            = request.server.prisma;

    const existing = await prisma.chatRule.findFirst({
      where: { id: ruleId, organizationId: orgId },
    });
    if (!existing) return reply.code(404).send({ error: 'RULE_NOT_FOUND' });

    await prisma.chatRule.delete({ where: { id: ruleId } });

    request.log.info({ ruleId, orgId }, 'ChatRule deleted');
    return { deleted: true, ruleId };
  });

  // ── POST /admin/organizations/:orgId/chat-rules/test ──────────────────────
  // Dry-run: test how a message would be handled without persisting anything.
  // Useful to validate new rules before activating them.
  app.post('/admin/organizations/:orgId/chat-rules/test', {
    preHandler: [adminAuth],
    schema: {
      body: {
        type:       'object',
        required:   ['message'],
        properties: { message: { type: 'string', minLength: 1, maxLength: 4000 } },
      },
    },
  }, async (request, reply) => {
    const { orgId } = request.params;
    const { message } = request.body;
    const prisma = request.server.prisma;

    // 1. Name capture
    const capturedName = tryCaptureName(message);
    if (capturedName) {
      return {
        matchedBy:   'name-capture',
        capturedName,
        reply:       `Hi ${capturedName}, how may I help you today?`,
        ruleId:      null,
      };
    }

    // 2. Rule match (include disabled rules in test so devs can preview before enabling)
    const rules = await prisma.chatRule.findMany({
      where:   { organizationId: orgId },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });

    // Find which specific rule matched (for highlighting in the dashboard)
    for (const rule of rules) {
      const hit = matchRules(message, [rule]);  // test one at a time to get the ID
      if (hit) {
        return {
          matchedBy: 'rule',
          ruleId:    rule.id,
          label:     rule.label,
          reply:     rule.replyText,
        };
      }
    }

    // 3. Fallback
    return {
      matchedBy: 'fallback',
      ruleId:    null,
      reply:     FALLBACK_MESSAGE,
    };
  });
}
