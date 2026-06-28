// src/routes/webhooks/vapi.js
// ─────────────────────────────────────────────────────────────────────────────
// VAPI VOICE WEBHOOK ENDPOINT
//
// Vapi.ai POSTs to this URL when a call ends (or on other call lifecycle events).
// The URL is configured per-assistant in the Vapi dashboard as the "Server URL".
//
// Multi-tenant routing strategy:
//   Option A (recommended): Embed the orgId in the webhook URL itself:
//     POST /webhooks/vapi/org_<cuid>
//     No API key needed — Vapi signs requests with a secret instead.
//
//   Option B: Use a shared webhook URL and route by vapiAssistantId:
//     POST /webhooks/vapi  (single URL for all tenants)
//     Lookup org by assistantId in the DB.
//
// We implement Option A as primary + Option B as fallback for robustness.
//
// Security: Vapi signs webhook payloads with HMAC-SHA256.
//   Header: x-vapi-secret (a shared secret set in Vapi dashboard)
//   We verify this before any DB writes to prevent spoofed webhooks.
// ─────────────────────────────────────────────────────────────────────────────

import { createHmac, timingSafeEqual } from 'crypto';
import { sendCallReportEmail }          from '../../services/email.js';
import { generateCallSummary }          from '../../services/ai-summarizer.js';

// ─────────────────────────────────────────────────────────────────────────────
// Signature verification helper
// ─────────────────────────────────────────────────────────────────────────────
function verifyVapiSignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  try {
    return timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected,  'hex')
    );
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Route registration — called from server.js via app.register()
// ─────────────────────────────────────────────────────────────────────────────
export default async function vapiWebhookRoutes(app) {

  // ── POST /webhooks/vapi/:orgId ─────────────────────────────────────────────
  app.post('/webhooks/vapi/:orgId', {
    config: { skipApiKeyAuth: true },   // custom flag — don't run apiKeyMiddleware
    schema: {
      params: {
        type:       'object',
        properties: { orgId: { type: 'string' } },
        required:   ['orgId'],
      },
    },
  }, async (request, reply) => {
    const { orgId } = request.params;
    const prisma    = request.server.prisma;
    const log       = request.log;

    // ── 1. Verify Vapi signature ────────────────────────────────────────────
    // Retrieve the org's Vapi webhook secret from env or DB config.
    // Each org should have their own secret (set in their Vapi dashboard).
    const vapiSecret  = process.env[`VAPI_WEBHOOK_SECRET_${orgId}`]
                     ?? process.env.VAPI_WEBHOOK_SECRET_DEFAULT;
    const signature   = request.headers['x-vapi-secret'];

    if (!verifyVapiSignature(request.rawBody, signature, vapiSecret)) {
      log.warn({ orgId }, 'Vapi webhook › signature mismatch');
      return reply.code(401).send({ error: 'INVALID_SIGNATURE' });
    }

    // ── 2. Parse the Vapi event payload ────────────────────────────────────
    const event = request.body;
    log.info({ orgId, eventType: event?.message?.type }, 'Vapi webhook received');

    // Vapi wraps everything in a `message` envelope
    const msg = event?.message ?? event;

    // Only process end-of-call reports (ignore other event types)
    if (msg.type !== 'end-of-call-report') {
      return reply.code(200).send({ received: true, processed: false });
    }

    // ── 3. Resolve the organization ────────────────────────────────────────
    let org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, ownerEmail: true, ownerName: true, brandName: true, status: true },
    });

    // Option B fallback: if org not found by URL param, try by assistantId
    if (!org && msg.call?.assistantId) {
      org = await prisma.organization.findFirst({
        where:  { vapiAssistantId: msg.call.assistantId },
        select: { id: true, ownerEmail: true, ownerName: true, brandName: true, status: true },
      });
    }

    if (!org) {
      log.error({ orgId, assistantId: msg.call?.assistantId }, 'Vapi webhook › org not found');
      return reply.code(404).send({ error: 'ORG_NOT_FOUND' });
    }

    if (org.status !== 'ACTIVE') {
      return reply.code(200).send({ received: true, processed: false, reason: 'org_inactive' });
    }

    // ── 4. Extract call data from the Vapi payload ─────────────────────────
    // Vapi's end-of-call-report structure (v2 API):
    const call      = msg.call ?? {};
    const artifact  = msg.artifact ?? {};

    const vapiCallId  = call.id;
    const durationSec = call.endedAt && call.startedAt
      ? Math.round((new Date(call.endedAt) - new Date(call.startedAt)) / 1000)
      : null;

    // Transcript arrives as an array of {role, message, time} objects
    const rawTranscript = artifact.messages ?? [];
    const normalizedTranscript = rawTranscript.map(m => ({
      role:      m.role === 'bot' ? 'assistant' : 'user',
      content:   m.message ?? m.content ?? '',
      timestamp: m.time ?? null,
    }));

    // ── 5. AI-generated summary and sentiment ──────────────────────────────
    // Run async — don't let summarization delay the 200 response to Vapi.
    // (Vapi has a short timeout for webhook acknowledgment.)
    const summaryPromise = generateCallSummary(normalizedTranscript, org).catch(err => {
      log.error({ err }, 'Call summary generation failed');
      return { summary: null, sentiment: null, actionItems: [] };
    });

    // ── 6. Upsert CallLog (idempotent on vapiCallId) ───────────────────────
    const callLog = await prisma.callLog.upsert({
      where:  { vapiCallId: vapiCallId ?? `unknown_${Date.now()}` },
      create: {
        organizationId:  org.id,
        vapiCallId:      vapiCallId,
        vapiAssistantId: call.assistantId,
        callerNumber:    call.customer?.number ?? null,
        calledNumber:    call.phoneNumber?.number ?? null,
        direction:       call.type === 'outboundPhoneCall' ? 'OUTBOUND' : 'INBOUND',
        durationSeconds: durationSec,
        status:          mapCallStatus(call.endedReason),
        endedReason:     call.endedReason ?? null,
        transcript:      normalizedTranscript,
        // Summary will be patched in once the async job finishes (step 7)
      },
      update: {
        // Idempotency: if Vapi retries the webhook, update instead of duplicating
        durationSeconds: durationSec,
        transcript:      normalizedTranscript,
        status:          mapCallStatus(call.endedReason),
        endedReason:     call.endedReason ?? null,
      },
    });

    log.info({ callLogId: callLog.id, orgId: org.id }, 'CallLog upserted');

    // Acknowledge Vapi immediately — never make Vapi wait for email/AI
    reply.code(200).send({ received: true, callLogId: callLog.id });

    // ── 7. Post-acknowledgment async work ─────────────────────────────────
    // Everything below runs AFTER the HTTP response is sent.
    // Vapi only cares about the 200; we do enrichment independently.
    ;(async () => {
      try {
        const { summary, sentiment, actionItems } = await summaryPromise;

        // Patch the CallLog with AI-generated fields
        await prisma.callLog.update({
          where: { id: callLog.id },
          data:  { summary, sentiment, actionItems: actionItems ?? [] },
        });

        // Send call report email to the org owner
        await sendCallReportEmail({
          org,
          callLog: { ...callLog, summary, sentiment, actionItems, transcript: normalizedTranscript },
        });

        await prisma.callLog.update({
          where: { id: callLog.id },
          data:  { reportEmailedAt: new Date() },
        });

        log.info({ callLogId: callLog.id }, 'Post-call enrichment complete');
      } catch (err) {
        log.error({ err, callLogId: callLog.id }, 'Post-call enrichment failed');
      }
    })();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: map Vapi's endedReason to our CallStatus enum
// ─────────────────────────────────────────────────────────────────────────────
function mapCallStatus(endedReason) {
  if (!endedReason) return 'COMPLETED';
  const reason = endedReason.toLowerCase();
  if (reason.includes('voicemail'))              return 'VOICEMAIL';
  if (reason.includes('no-answer') || reason.includes('busy')) return 'NO_ANSWER';
  if (reason.includes('error') || reason.includes('fail'))     return 'FAILED';
  return 'COMPLETED';
}
