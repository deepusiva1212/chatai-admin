import { OpenAI } from 'openai';

// Initialize OpenAI client using the key from your environment file
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Core Supervisor routing brain.
 * Handles incoming multi-tenant customer messages based on their scoped organization.
 */
export async function route(message, organizationId, prisma) {
  try {
    // 1. Fetch the organization's unique knowledge base reference from the database
    const orgConfig = await prisma.organization.findUnique({
      where: { id: organizationId },
      include: { knowledgeBases: true }
    });

    if (!orgConfig) {
      throw new Error('Tenant organization not found or inactive.');
    }

    // 2. Call OpenAI to generate a customer support response
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { 
          role: 'system', 
          content: `You are an elite, white-label AI customer support agent representing the company: ${orgConfig.name}. 
          Answer questions politely, concisely, and professionally based on their product profile.` 
        },
        { role: 'user', content: message }
      ],
    });

    return {
      agent: orgConfig.name,
      text: completion.choices[0].message.content,
      status: 'success'
    };

  } catch (error) {
    console.error('Supervisor Error:', error);
    return {
      agent: 'System Supervisor',
      text: "I'm having trouble processing that right now. Please try again shortly.",
      status: 'error'
    };
  }
}