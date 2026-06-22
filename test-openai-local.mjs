// Local test for OpenAI image API — run with: node test-openai-local.mjs
import OpenAI from 'openai';
import { readFileSync } from 'fs';

// Load env
const envLines = readFileSync('.env', 'utf-8').split('\n');
for (const line of envLines) {
  const [k, ...v] = line.split('=');
  if (k && v.length) process.env[k.trim()] = v.join('=').trim();
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function testModel(model, extraParams = {}) {
  console.log(`\n--- Testing model: ${model} ---`);
  try {
    const resp = await openai.images.generate({
      model,
      prompt: 'Professional studio photo of makeup brushes on white background. No text.',
      n: 1,
      size: '1024x1024',
      ...extraParams,
    });
    const item = resp.data?.[0];
    console.log('  url:', item?.url ? item.url.slice(0, 80) + '...' : 'none');
    console.log('  b64_json length:', item?.b64_json?.length ?? 'none');
    return item;
  } catch (e) {
    console.log('  ERROR:', e.message);
    return null;
  }
}

// Test dall-e-3 (URL format)
await testModel('dall-e-3', { response_format: 'url' });
await testModel('dall-e-3', { response_format: 'b64_json' });
await testModel('dall-e-3');

// Test gpt-image-1 low quality
await testModel('gpt-image-1', { quality: 'low' });
await testModel('gpt-image-1', { quality: 'low', output_format: 'jpeg', size: '1024x1024' });

console.log('\nDone.');
