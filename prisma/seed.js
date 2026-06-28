// prisma/seed.js
// Creates your two first-party tenant organizations in the dev database
import { PrismaClient } from '@prisma/client';
import { generateApiKey } from '../src/middleware/api-key.js';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding development database...');

  // ── MyTripRaja ─────────────────────────────────────────────────────────────
  const tripRaja = await prisma.organization.upsert({
    where:  { slug: 'mytripraja' },
    update: {},
    create: {
      name:              'MyTripRaja',
      slug:              'mytripraja',
      plan:              'GROWTH',
      ownerEmail:        'admin@mytripraja.com',
      ownerName:         'Deepu Siva',
      brandName:         'TripBot',
      brandPrimaryColor: '#0f766e',
      brandFontFamily:   'Inter',
      allowedOrigins:    ['https://mytripraja.com', 'http://localhost:5173'],
    },
  });

  const { rawKey: tripKey, keyHash: tripHash, keyPrefix: tripPrefix } = generateApiKey('live');
  await prisma.apiKey.create({
    data: {
      organizationId: tripRaja.id,
      name:           'Production',
      keyPrefix:      tripPrefix,
      keyHash:        tripHash,
    },
  });
  console.log(`✅ MyTripRaja created. API Key (save this!): ${tripKey}`);

  // ── Deepu Siva Private Ltd ─────────────────────────────────────────────────
  const deepuSiva = await prisma.organization.upsert({
    where:  { slug: 'deepusiva' },
    update: {},
    create: {
      name:              'Deepu Siva Private Limited',
      slug:              'deepusiva',
      plan:              'GROWTH',
      ownerEmail:        'admin@deepusiva.com',
      ownerName:         'Deepu Siva',
      brandName:         'Deepu AI',
      brandPrimaryColor: '#7c3aed',
      brandFontFamily:   'Inter',
      allowedOrigins:    ['https://deepusiva.com', 'http://localhost:5173'],
    },
  });

  const { rawKey: deepuKey, keyHash: deepuHash, keyPrefix: deepuPrefix } = generateApiKey('live');
  await prisma.apiKey.create({
    data: {
      organizationId: deepuSiva.id,
      name:           'Production',
      keyPrefix:      deepuPrefix,
      keyHash:        deepuHash,
    },
  });
  console.log(`✅ Deepu Siva PL created. API Key (save this!): ${deepuKey}`);
  console.log('\n⚠️  Save the API keys above — they are shown only once.');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
