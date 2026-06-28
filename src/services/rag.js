// src/services/rag.js
// ─────────────────────────────────────────────────────────────────────────────
// RAG SERVICE — Retrieval-Augmented Generation per tenant
//
// Isolation strategy:
//   Every tenant's embeddings live in the same pgvector table but are
//   partitioned by `namespace` (= vectorNamespace from KnowledgeBase row).
//   Format: "org_<slug>_<kbId>"  e.g. "org_mytripraja_clx123abc"
//
//   This means:
//     - Zero cross-tenant leakage (namespace filter is always applied)
//     - One shared pgvector index (cost-efficient for early scale)
//     - Easy migration to Pinecone namespaces with no code change
//       (just swap the PGVectorStore for PineconeStore below)
// ─────────────────────────────────────────────────────────────────────────────

import { OpenAIEmbeddings }   from '@langchain/openai';
import { PGVectorStore }      from '@langchain/community/vectorstores/pgvector';
import { ChatAnthropic }      from '@langchain/anthropic';
import { ChatOpenAI }         from '@langchain/openai';
import {
  ChatPromptTemplate,
  HumanMessagePromptTemplate,
  SystemMessagePromptTemplate,
} from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { RunnableSequence }   from '@langchain/core/runnables';

// ── Shared embedding model (one instance, reused across tenants) ──────────────
const embeddings = new OpenAIEmbeddings({
  model:  'text-embedding-3-small',
  apiKey: process.env.OPENAI_API_KEY,
});

// ── pgvector connection config ────────────────────────────────────────────────
const pgConfig = {
  postgresConnectionOptions: { connectionString: process.env.DATABASE_URL },
  tableName:                 'document_embeddings',   // managed by LangChain, not Prisma
  columns: {
    idColumnName:        'id',
    vectorColumnName:    'embedding',
    contentColumnName:   'content',
    metadataColumnName:  'metadata',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// getVectorStore — returns a PGVectorStore scoped to one tenant's namespace
// ─────────────────────────────────────────────────────────────────────────────
async function getVectorStore(vectorNamespace) {
  return PGVectorStore.initialize(embeddings, {
    ...pgConfig,
    // Filter all queries to this tenant's namespace — enforced at SQL level
    filter: { namespace: vectorNamespace },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// buildRAGChain — constructs a LangChain retrieval chain for a specific KB
//
// Chain flow:
//   User question
//     → embed question
//     → similarity search (top-K docs from this tenant's namespace only)
//     → inject docs as context into system prompt
//     → LLM generates answer grounded in those docs
//     → return { answer, sourceDocs }
// ─────────────────────────────────────────────────────────────────────────────
export async function buildRAGChain(knowledgeBase, organization) {
  const vectorStore = await getVectorStore(knowledgeBase.vectorNamespace);
  const retriever   = vectorStore.asRetriever({
    k: knowledgeBase.retrievalTopK ?? 5,
  });

  // Choose LLM — prefer Claude, fall back to OpenAI
  const llm = process.env.ANTHROPIC_API_KEY
    ? new ChatAnthropic({
        model:       'claude-sonnet-4-6',
        apiKey:      process.env.ANTHROPIC_API_KEY,
        maxTokens:   1024,
        temperature: 0.3,   // lower temp for factual KB answers
      })
    : new ChatOpenAI({
        model:       'gpt-4o-mini',
        apiKey:      process.env.OPENAI_API_KEY,
        maxTokens:   1024,
        temperature: 0.3,
      });

  const systemPrompt = knowledgeBase.systemPromptOverride
    ?? `You are ${organization.brandName ?? 'an AI assistant'} helping customers.
Answer questions using ONLY the provided context. If the answer is not in the context,
say "I don't have that information — please contact our support team."
Be concise, helpful, and professional. Never make up facts.`;

  const prompt = ChatPromptTemplate.fromMessages([
    SystemMessagePromptTemplate.fromTemplate(
      `${systemPrompt}\n\nContext from knowledge base:\n{context}`
    ),
    HumanMessagePromptTemplate.fromTemplate('{question}'),
  ]);

  // Runnable sequence: retrieve → format → prompt → LLM → parse
  const chain = RunnableSequence.from([
    {
      // Step 1: retrieve relevant docs and pass question through
      context:  async (input) => {
        const docs = await retriever.getRelevantDocuments(input.question);
        return docs.map(d => d.pageContent).join('\n\n---\n\n');
      },
      question: (input) => input.question,
      // Carry source docs through for citation
      _sourceDocs: async (input) => retriever.getRelevantDocuments(input.question),
    },
    // Step 2: format prompt
    {
      answer:     RunnableSequence.from([prompt, llm, new StringOutputParser()]),
      sourceDocs: (input) => input._sourceDocs,
    },
  ]);

  return chain;
}

// ─────────────────────────────────────────────────────────────────────────────
// queryKnowledgeBase — the primary exported function used by chat routes
// ─────────────────────────────────────────────────────────────────────────────
export async function queryKnowledgeBase({ question, knowledgeBase, organization }) {
  const chain  = await buildRAGChain(knowledgeBase, organization);
  const result = await chain.invoke({ question });

  return {
    answer:     result.answer,
    sourceDocs: (result.sourceDocs ?? []).map(d => ({
      content:  d.pageContent.slice(0, 200) + '...',
      source:   d.metadata?.source ?? 'Knowledge Base',
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ingestDocuments — add documents to a tenant's knowledge base
// Called by the /api/knowledge-bases/:id/ingest endpoint
// ─────────────────────────────────────────────────────────────────────────────
export async function ingestDocuments({ documents, vectorNamespace }) {
  // `documents` = [{ pageContent: string, metadata: object }]
  // Tag every doc with the namespace so the filter works at retrieval time
  const taggedDocs = documents.map(doc => ({
    ...doc,
    metadata: { ...doc.metadata, namespace: vectorNamespace },
  }));

  const vectorStore = await getVectorStore(vectorNamespace);
  await vectorStore.addDocuments(taggedDocs);

  return { ingested: taggedDocs.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// deleteNamespace — removes all vectors for a tenant's KB
// Called when a KnowledgeBase is deleted
// ─────────────────────────────────────────────────────────────────────────────
export async function deleteNamespace(vectorNamespace) {
  // Raw SQL: delete all rows in this namespace from the embeddings table
  // PGVectorStore doesn't expose a delete-by-filter method yet
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  await prisma.$executeRawUnsafe(
    `DELETE FROM document_embeddings WHERE metadata->>'namespace' = $1`,
    vectorNamespace
  );
  await prisma.$disconnect();
}
