// src/routes/chat.js
// ─────────────────────────────────────────────────────────────────────────────
// CHAT ROUTE — tenant-aware chat with optional RAG
//
// Every request here has already passed apiKeyMiddleware, so:
//   request.organizationId  — guaranteed to be set
//   request.organization    — full org row with brand config
//   request.db              — tenant-scoped Prisma (RLS active)
// ─────────────────────────────────────────────────────────────────────────────

import { apiKeyMiddleware }      from '../middleware/api-key.js';
import { route as supervisorRoute } from '../core/supervisor.js';
import { queryKnowledgeBase }    from '../services/rag.js';

export default async function chatRoutes(app) {

  // ── POST /api/chat ─────────────────────────────────────────────────────────
  app.post('/api/chat', {
    // preHandler: [apiKeyMiddleware],
    schema: {
      body: {
        type: 'object',
        required: ['message'],
        properties: {
          message:       { type: 'string', minLength: 1, maxLength: 8000 },
          sessionToken:  { type: 'string' },   // links messages to a ChatSession
          history:       {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                role:    { type: 'string', enum: ['user', 'assistant'] },
                content: { type: 'string' },
              },
            },
          },
          knowledgeBaseId: { type: 'string' },  // optional: enable RAG for this request
          endUserRef:      { type: 'string' },  // caller's own user ID
        },
      },
    },
  }, async (request, reply) => {
    console.log("Chat route was triggered!");
    const { message, sessionToken, history = [], knowledgeBaseId, endUserRef } = request.body;
    const { organizationId, organization, db } = request;
    const log = request.log;

    // ── 1. Resolve or create ChatSession ─────────────────────────────────
    let session = null;
    if (sessionToken) {
      session = await db.chatSession.upsert({
        where:  { sessionToken },
        create: {
          organizationId,
          sessionToken,
          endUserRef: endUserRef ?? null,
          origin:     request.headers['origin'] ?? null,
        },
        update: { updatedAt: new Date() },
      });
    }

    // ── 2. RAG augmentation (if a KB is specified) ────────────────────────
    let ragContext = null;
    let ragSources = [];

    if (knowledgeBaseId) {
      const kb = await db.knowledgeBase.findUnique({
        where: { id: knowledgeBaseId },
      });

      if (kb && kb.status === 'READY') {
        log.info({ kbId: kb.id, namespace: kb.vectorNamespace }, 'RAG › querying KB');
        const ragResult = await queryKnowledgeBase({
          question:      message,
          knowledgeBase: kb,
          organization,
        }).catch(err => {
          log.error({ err }, 'RAG › query failed, falling back to plain LLM');
          return null;
        });

        if (ragResult) {
          ragContext = ragResult.answer;
          ragSources = ragResult.sourceDocs;
        }
      }
    }

    // ── 3. Build message history for the Supervisor ───────────────────────
    const messages = [
      ...history,
      // If RAG found relevant context, inject it as a system note before the user message
      ...(ragContext
        ? [{ role: 'assistant', content: `[Knowledge Base Context]: ${ragContext}` }]
        : []),
      { role: 'user', content: message },
    ];

    // ── 4. Route through Supervisor ───────────────────────────────────────
    const result = await supervisorRoute({
      prompt:    message,
      messages,
      sessionId: session?.id ?? organizationId,
      logger:    log,
      // Pass org brand config so agents can personalise responses
      orgContext: {
        brandName:     organization.brandName,
        systemPrompt:  organization.brandName
          ? `You are ${organization.brandName}, an AI assistant. Be helpful and professional.`
          : undefined,
      },
    });

    // ── 5. Persist messages ───────────────────────────────────────────────
    if (session) {
      await db.chatMessage.createMany({
        data: [
          {
            sessionId: session.id,
            role:      'user',
            content:   message,
          },
          {
            sessionId: session.id,
            role:      'assistant',
            content:   result.text,
            agent:     result.agent,
            provider:  result.provider,
            latencyMs: result.latencyMs,
          },
        ],
      });
    }

    // ── 6. Response ───────────────────────────────────────────────────────
    return reply.send({
      success:    true,
      text:       result.text,
      agent:      result.agent,
      intent:     result.intent,
      provider:   result.provider,
      fallback:   result.fallbackUsed,
      latencyMs:  result.latencyMs,
      sessionToken,
      // Include RAG source references for the widget to display
      sources:    ragSources.length > 0 ? ragSources : undefined,
      // Embed brand config in the response so the widget can render correctly
      brand: {
        name:         organization.brandName,
        logoUrl:      organization.brandLogoUrl,
        primaryColor: organization.brandPrimaryColor,
        fontFamily:   organization.brandFontFamily,
      },
    });
  });

  // ── GET /api/widget-config ─────────────────────────────────────────────────
  // Called by the widget on init to fetch brand settings without sending a message
  app.get('/api/widget-config', {
    preHandler: [apiKeyMiddleware],
  }, async (request, reply) => {
    const { organization } = request;
    return {
      brandName:    organization.brandName    ?? 'AI Assistant',
      logoUrl:      organization.brandLogoUrl ?? null,
      primaryColor: organization.brandPrimaryColor ?? '#4f46e5',
      fontFamily:   organization.brandFontFamily   ?? 'Inter',
    };
  });
}
