// src/services/email.js
// ─────────────────────────────────────────────────────────────────────────────
// EMAIL SERVICE
// Sends post-call reports to organization owners.
// Uses Nodemailer with SMTP (swap transport for SendGrid/Resend in prod).
// ─────────────────────────────────────────────────────────────────────────────

import nodemailer from 'nodemailer';

// ── Transport (configure via env) ────────────────────────────────────────────
const transport = nodemailer.createTransport({
  host:   process.env.SMTP_HOST   ?? 'smtp.gmail.com',
  port:   parseInt(process.env.SMTP_PORT ?? '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// sendCallReportEmail
// ─────────────────────────────────────────────────────────────────────────────
export async function sendCallReportEmail({ org, callLog }) {
  if (!org.ownerEmail) return;

  const agentName = org.brandName ?? 'Your AI Agent';
  const duration  = callLog.durationSeconds
    ? `${Math.floor(callLog.durationSeconds / 60)}m ${callLog.durationSeconds % 60}s`
    : 'Unknown';

  const transcriptHtml = (callLog.transcript ?? [])
    .map(m => `
      <tr>
        <td style="padding:6px 12px;font-weight:600;color:${m.role === 'user' ? '#1d4ed8' : '#059669'};white-space:nowrap;vertical-align:top">
          ${m.role === 'user' ? '👤 Caller' : '🤖 Agent'}
        </td>
        <td style="padding:6px 12px;color:#374151">${escHtml(m.content)}</td>
      </tr>`)
    .join('');

  const actionItemsHtml = (callLog.actionItems ?? []).length > 0
    ? `<ul>${callLog.actionItems.map(a => `<li>${escHtml(a)}</li>`).join('')}</ul>`
    : '<p style="color:#6b7280">No action items identified.</p>';

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Inter,system-ui,sans-serif;max-width:680px;margin:0 auto;background:#f9fafb;padding:24px">
  <div style="background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
    <div style="background:${org.brandPrimaryColor ?? '#4f46e5'};padding:24px 32px">
      <h1 style="color:#fff;margin:0;font-size:22px">${agentName} — Call Report</h1>
      <p style="color:rgba(255,255,255,0.8);margin:6px 0 0;font-size:14px">
        ${new Date(callLog.createdAt ?? Date.now()).toLocaleString()}
      </p>
    </div>

    <div style="padding:28px 32px">
      <!-- Metadata grid -->
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
        <tr>
          <td style="padding:8px 0;color:#6b7280;font-size:13px">Caller</td>
          <td style="padding:8px 0;font-weight:500">${escHtml(callLog.callerNumber ?? 'Unknown')}</td>
          <td style="padding:8px 0;color:#6b7280;font-size:13px">Duration</td>
          <td style="padding:8px 0;font-weight:500">${duration}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;color:#6b7280;font-size:13px">Direction</td>
          <td style="padding:8px 0;font-weight:500">${callLog.direction}</td>
          <td style="padding:8px 0;color:#6b7280;font-size:13px">Sentiment</td>
          <td style="padding:8px 0;font-weight:500">${sentimentBadge(callLog.sentiment)}</td>
        </tr>
      </table>

      <!-- AI Summary -->
      <h2 style="font-size:16px;margin:0 0 12px;color:#111827">📋 Summary</h2>
      <p style="background:#f3f4f6;padding:16px;border-radius:8px;line-height:1.6;color:#374151;margin:0 0 24px">
        ${escHtml(callLog.summary ?? 'No summary generated.')}
      </p>

      <!-- Action items -->
      <h2 style="font-size:16px;margin:0 0 12px;color:#111827">✅ Action Items</h2>
      <div style="margin:0 0 24px">${actionItemsHtml}</div>

      <!-- Transcript -->
      <h2 style="font-size:16px;margin:0 0 12px;color:#111827">💬 Full Transcript</h2>
      <table style="width:100%;border-collapse:collapse;background:#f9fafb;border-radius:8px;overflow:hidden">
        ${transcriptHtml}
      </table>
    </div>

    <div style="padding:16px 32px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:12px;text-align:center">
      Powered by ${agentName} · Call ID: ${callLog.vapiCallId ?? callLog.id}
    </div>
  </div>
</body>
</html>`;

  await transport.sendMail({
    from:    `"${agentName}" <${process.env.SMTP_FROM ?? process.env.SMTP_USER}>`,
    to:      org.ownerEmail,
    subject: `📞 Call Report — ${duration} call on ${new Date().toLocaleDateString()}`,
    html,
  });
}

function sentimentBadge(s) {
  const map = { positive: '🟢 Positive', neutral: '🟡 Neutral', negative: '🔴 Negative' };
  return map[s] ?? '—';
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}
