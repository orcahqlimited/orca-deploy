import https from 'https';

const SOURCE_URL = 'https://d06383fd-ad0f-4008-8adc-bc74024e8ddc.eu-west-2-0.aws.cloud.qdrant.io:6333';
const SOURCE_KEY = process.env.QDRANT_CLOUD_KEY;
const TARGET_URL = 'https://qdrant.icyplant-8c8bf272.uksouth.azurecontainerapps.io';

const COLLECTIONS = ['practice-brain'];

async function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + (parsed.search || ''),
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function migrateCollection(name) {
  console.log(`\nMigrating ${name}...`);

  const info = await request(`${SOURCE_URL}/collections/${name}`, {
    headers: { 'api-key': SOURCE_KEY }
  });
  const vectorSize = info.result.config.params.vectors.size;
  const distance = info.result.config.params.vectors.distance;
  console.log(`  Vector size: ${vectorSize}, Distance: ${distance}`);

  await request(`${TARGET_URL}/collections/${name}`, { method: 'PUT' }, {
    vectors: { size: vectorSize, distance: distance }
  });
  console.log(`  Collection created in target`);

  let offset = null;
  let total = 0;

  do {
    const body = { limit: 100, with_payload: true, with_vector: true };
    if (offset) body.offset = offset;

    const result = await request(`${SOURCE_URL}/collections/${name}/points/scroll`, {
      method: 'POST',
      headers: { 'api-key': SOURCE_KEY }
    }, body);

    const points = result.result.points;
    offset = result.result.next_page_offset;

    if (points.length > 0) {
      await request(`${TARGET_URL}/collections/${name}/points`, { method: 'PUT' }, { points });
      total += points.length;
      console.log(`  Migrated ${total} points...`);
    }
  } while (offset);

  console.log(`  ✅ ${name}: ${total} points migrated`);
  return total;
}

async function main() {
  for (const col of COLLECTIONS) {
    await migrateCollection(col);
  }
  console.log('\nMigration complete.');
}

main().catch(console.error);
