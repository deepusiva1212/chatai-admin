// src/services/ai-summarizer.js
// ─────────────────────────────────────────────────────────────────────────────
// Generates a structured summary, sentiment, and action items from a call
// transcript using the primary LLM (falls back to OpenAI).
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk';
import OpenAI    from 'openai';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai    = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function generateCallSummary(transcript, org) {
  const transcriptText = transcript
    .map(m => `${m.role === 'user' ? 'CALLER' : 'AGENT'}: ${m.content}`)
    .join('\n');

  const systemPrompt = `You are a call analysis specialist for ${org.brandName ?? 'a business'}.
Analyze this voice call transcript and return ONLY valid JSON with this exact structure:
{
  "summary": "2-3 sentence summary of what the call was about and how it was resolved",
  "sentiment": "positive" | "neutral" | "negative",
  "actionItems": ["action 1", "action 2"]
}
Be concise. actionItems should be specific follow-up tasks for the business. Return JSON only.`;

  const userMessage = `Transcript:\n${transcriptText || '(empty transcript)'}`;

  // Try Claude first, fall back to OpenAI
  let raw;
  try {
    const resp = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userMessage }],
    });
    raw = resp.content[0].text;
  } catch {
    const resp = await openai.chat.completions.create({
      model:      'gpt-4o-mini',
      max_tokens: 512,
      messages:   [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage  },
      ],
    });
    raw = resp.choices[0].message.content;
  }

  try {
    const clean = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return { summary: raw, sentiment: 'neutral', actionItems: [] };
  }
}
