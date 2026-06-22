import { PrismaClient } from '@prisma/client';
import OpenAI from 'openai';

const db = new PrismaClient();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const SHOP = 'drmtdf-we.myshopify.com';

async function gql(token, query, variables) {
  const r = await fetch(`https://${SHOP}/admin/api/2026-04/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  return r.json();
}

async function tryResourceType(token, b64Data, resource, httpMethod) {
  console.log(`\n[TRY] resource=${resource} httpMethod=${httpMethod}`);

  const stagedResp = await gql(token, `
    mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }
  `, {
    input: [{
      filename: 'article-image.jpg',
      mimeType: 'image/jpeg',
      resource,
      httpMethod,
    }]
  });

  if (stagedResp.errors) {
    console.log(`  GQL errors: ${JSON.stringify(stagedResp.errors)}`);
    return false;
  }
  const staged = stagedResp.data?.stagedUploadsCreate;
  if (staged?.userErrors?.length) {
    console.log(`  userErrors: ${JSON.stringify(staged.userErrors)}`);
    return false;
  }
  const target = staged?.stagedTargets?.[0];
  if (!target) {
    console.log('  No staged target returned, full response:', JSON.stringify(stagedResp));
    return false;
  }
  console.log(`  targetUrl: ${target.url.slice(0, 60)}...`);
  console.log(`  resourceUrl: ${target.resourceUrl.slice(0, 60)}...`);
  console.log(`  params: ${target.parameters.map(p => p.name).join(', ')}`);

  // Upload to S3
  const buffer = Buffer.from(b64Data, 'base64');
  let uploadStatus;

  if (httpMethod === 'POST') {
    const formData = new FormData();
    for (const { name, value } of target.parameters) formData.append(name, value);
    formData.append('file', new Blob([buffer], { type: 'image/jpeg' }), 'article-image.jpg');
    const uploadResp = await fetch(target.url, { method: 'POST', body: formData });
    uploadStatus = uploadResp.status;
    if (uploadStatus >= 300) {
      const txt = await uploadResp.text();
      console.log(`  S3 POST failed ${uploadStatus}: ${txt.slice(0, 200)}`);
      return false;
    }
  } else {
    const uploadResp = await fetch(target.url, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: buffer,
    });
    uploadStatus = uploadResp.status;
    if (uploadStatus >= 300) {
      const txt = await uploadResp.text();
      console.log(`  S3 PUT failed ${uploadStatus}: ${txt.slice(0, 200)}`);
      return false;
    }
  }
  console.log(`  S3 upload OK (status ${uploadStatus})`);

  // fileCreate
  const fcResp = await gql(token, `
    mutation FileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files { id fileStatus ... on MediaImage { image { url } } }
        userErrors { field message }
      }
    }
  `, { files: [{ alt: 'test image', contentType: 'IMAGE', originalSource: target.resourceUrl }] });

  if (fcResp.errors) { console.log(`  fileCreate GQL errors: ${JSON.stringify(fcResp.errors)}`); return false; }
  const fc = fcResp.data?.fileCreate;
  if (fc?.userErrors?.length) { console.log(`  fileCreate userErrors: ${JSON.stringify(fc.userErrors)}`); return false; }
  const file = fc?.files?.[0];
  if (!file) { console.log('  fileCreate returned no file'); return false; }
  console.log(`  fileCreate OK: id=${file.id?.slice(0, 30)} status=${file.fileStatus}`);

  // Poll for READY
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const poll = await gql(token,
      `query GetNode($id: ID!) { node(id: $id) { ... on MediaImage { fileStatus image { url } } } }`,
      { id: file.id }
    );
    const node = poll?.data?.node;
    console.log(`  poll[${i}] status=${node?.fileStatus} url=${node?.image?.url?.slice(0, 60) ?? 'none'}`);
    if (node?.fileStatus === 'READY') {
      console.log(`  SUCCESS! CDN URL: ${node.image.url}`);
      return true;
    }
  }
  console.log('  Timed out polling for READY');
  return false;
}

async function main() {
  const session = await db.session.findFirst({ where: { shop: SHOP } });
  const token = session.accessToken;
  console.log('[1] Session OK');

  console.log('[2] Generating gpt-image-1 JPEG (low quality)...');
  const img = await openai.images.generate({
    model: 'gpt-image-1',
    prompt: 'Professional studio photo of makeup brushes on neutral background. No text.',
    n: 1,
    size: '1024x1024',
    quality: 'low',
    output_format: 'jpeg',
  });
  const b64Data = img.data?.[0]?.b64_json;
  if (!b64Data) throw new Error('No b64_json');
  console.log(`[3] Got JPEG, b64 length: ${b64Data.length}`);

  // Try different resource/method combinations
  const success =
    await tryResourceType(token, b64Data, 'IMAGE', 'POST') ||
    await tryResourceType(token, b64Data, 'FILE', 'POST') ||
    await tryResourceType(token, b64Data, 'IMAGE', 'PUT') ||
    await tryResourceType(token, b64Data, 'FILE', 'PUT');

  if (!success) console.log('\n[FAILED] None of the combinations worked');
}

main()
  .catch(e => console.error('[FATAL]', e.message))
  .finally(() => db.$disconnect());
