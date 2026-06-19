# Feature Gaps — AI Implementation Context

> For AI coding assistants implementing missing features in `C:\projects\blog-generate`.  
> Traces each gap to the exact prototype source at `C:\projects\shopify-blog-automation`.  
> Human summary → `GAPS_HUMAN.md`

---

## Project Context

**Current app:** React Router 7 + Node.js, Prisma/Postgres, Fly.io, Shopify GraphQL Admin API 2025-10  
**Prototype:** Supabase Edge Functions (Deno/TypeScript), Shopify REST API 2024-10, pg_cron scheduler  
**Key difference:** Prototype is single-tenant (one store, hardcoded IDs). Current app is multi-tenant (per-shop `BlogSettings` row).

**Critical files in current app:**
```
app/services/blog/openai.server.ts          — chatComplete(), chatCompleteJSON() wrappers
app/services/blog/articleWriter.server.ts   — enrichKeywords(), researchTopic(), generateArticleBody(), generateArticleMetadata(), publishPlanItem()
app/services/blog/shopifyBlog.server.ts     — getShopifyBlogs(), getShopifyArticles(), publishArticleToShopify()
app/services/blog/contentPlanner.server.ts  — generateWeeklyPlan(), getTodaysPlan(), weekAlreadyPlanned()
app/services/blog/deduplication.server.ts   — isDuplicate(), computeSimilarity()
app/routes/api.cron.daily.tsx               — POST /api/cron/daily (x-cron-secret auth)
app/routes/api.cron.weekly.tsx              — POST /api/cron/weekly (x-cron-secret auth)
scripts/cron-runner.mjs                     — node-cron scheduler (Monday 09:00, daily 10:00)
prisma/schema.prisma                        — BlogContentPlan, BlogSettings, Session
```

---

## GAP 1 — SEO Metafields

### What's missing
`publishArticleToShopify()` in `shopifyBlog.server.ts` does not set `seo.title` and `seo.description` metafields. Google uses these as the page `<title>` and `<meta name="description">`. Without them, Google picks its own text.

### Prototype reference
**File:** `C:\projects\shopify-blog-automation\supabase\functions\shopify-blog-automation-ultra-seo\index.ts`  
Search for `metafields` — the `createArticle()` function sends:
```json
"metafields": [
  { "namespace": "seo", "key": "title", "value": "<seoTitle>", "type": "single_line_text_field" },
  { "namespace": "seo", "key": "description", "value": "<metaDescription>", "type": "single_line_text_field" }
]
```
Prototype uses REST API (`POST /admin/api/2024-10/blogs/{blogId}/articles.json`). Current app uses GraphQL.

### GraphQL equivalent
In Shopify GraphQL Admin API 2025-10, `ArticleCreateInput` accepts a `metafields` field:
```graphql
metafields: [
  { namespace: "seo", key: "title", value: $seoTitle, type: "single_line_text_field" },
  { namespace: "seo", key: "description", value: $metaDescription, type: "single_line_text_field" }
]
```

### What to change

**`app/services/blog/shopifyBlog.server.ts` — `publishArticleToShopify()`:**  
- Accept `seoTitle` and `metaDescription` in the article input object
- Add `metafields` array to the `ArticleCreateInput` variable in the mutation

**`app/services/blog/articleWriter.server.ts` — `publishPlanItem()`:**  
- `generateArticleMetadata()` already returns `seoTitle` and `metaDescription`
- Pass both to `publishArticleToShopify()`

### Verification
After publishing a test article, open Shopify Admin → Content → Articles → [article] → scroll to Metafields section. Should see `seo / title` and `seo / description` entries with the correct values.

---

## GAP 2 — Retry Cron at 11:00 UTC

### What's missing
`scripts/cron-runner.mjs` schedules daily publish at 10:00 UTC only. A transient failure = missed article until tomorrow.

### Prototype reference
**File:** `C:\projects\shopify-blog-automation\cron\schedule.sql`  
Two separate pg_cron jobs:
```sql
-- primary
'0 10 * * *'  → shopify-blog-automation-ultra-seo
-- retry
'0 11 * * *'  → shopify-blog-automation-ultra-seo (same function, safe no-op if already published)
```
The function checks `isTodayAlreadyPublished()` first and returns early if true.

### What to change
**`scripts/cron-runner.mjs`:**  
Add a second `cron.schedule('0 11 * * *', ...)` block identical to the daily 10:00 one, calling `POST /api/cron/daily`. The endpoint is already idempotent — `getTodaysPlan()` queries `status IN ('planned','failed')` and returns nothing if today's article already has status `published`.

---

## GAP 3 — Perplexity AI for Research & Planning

### What's missing
`researchTopic()` in `articleWriter.server.ts` uses `chatComplete()` (GPT-4o) to generate a research brief. GPT-4o has knowledge cutoff and invents statistics. Perplexity `sonar` model performs live internet search and returns real data with citations.

### Prototype reference
**File:** `C:\projects\shopify-blog-automation\supabase\functions\shopify-blog-automation-ultra-seo\index.ts`  
Search for `PERPLEXITY_API_KEY` and `callPerplexity()`.

The function signature in prototype:
```typescript
async function callPerplexity(systemPrompt: string, userPrompt: string, maxTokens: number): Promise<string>
```
Uses OpenAI-compatible API:
```
base URL: https://api.perplexity.ai
model: sonar
Authorization: Bearer <PERPLEXITY_API_KEY>
```

Research step prompt (search for `researchPrompt` in prototype) asks for:
- 800–1000 words
- Real statistics with specific numbers
- Expert opinions and case studies
- Specifies current date to avoid outdated data

Planning step (search for `generateWeeklyTopics` in prototype) also uses Perplexity for trend awareness.

### What to change

**New file `app/services/blog/perplexity.server.ts`:**
```typescript
// Perplexity uses OpenAI-compatible API
// base URL: https://api.perplexity.ai
// model: sonar
// Same interface as chatComplete() in openai.server.ts
export async function perplexityComplete(messages, maxTokens): Promise<string>
```

**`app/services/blog/articleWriter.server.ts` — `researchTopic()`:**  
- Replace `chatComplete()` call with `perplexityComplete()`
- Add current date to the research prompt so Perplexity uses recent data

**Env/secrets:**  
- Add `PERPLEXITY_API_KEY` to `.env` and `fly secrets set PERPLEXITY_API_KEY=...`

### Verification
Add a `console.log` in `researchTopic()` logging the first 200 chars of the research output. Perplexity responses will contain specific numbers with year context (e.g. "In 2025, 67% of...") rather than vague GPT-style claims.

---

## GAP 4 — LSI Keywords in Keyword Enrichment

### What's missing
`enrichKeywords()` in `articleWriter.server.ts` generates a flat list of "8-12 SEO keywords". Prototype generates primary keywords and LSI (Latent Semantic Indexing) keywords as separate arrays, which allows the article generation prompt to weave semantic variants through the body — a signal of topical authority to Google.

### Prototype reference
**File:** `C:\projects\shopify-blog-automation\supabase\functions\shopify-blog-automation-ultra-seo\index.ts`  
Search for `enrichKeywords`. The JSON response schema:
```json
{
  "topic": "string",
  "keywords": ["primary keyword 1", "..."],
  "lsiKeywords": ["semantic variant 1", "..."],
  "searchVolume": "high|medium|low",
  "intentType": "informational|commercial"
}
```

### What to change

**`app/services/blog/articleWriter.server.ts` — `enrichKeywords()`:**  
- Update the prompt to request `keywords` (3–4 primary), `lsiKeywords` (5 LSI terms), `searchVolume` (high/medium/low), `intentType`
- Update the return type to include `lsiKeywords: string[]`
- Pass both `keywords` and `lsiKeywords` into `researchTopic()` and `generateArticleBody()` prompts

**Prisma schema (optional):**  
Add `lsiKeywords String[]` to `BlogContentPlan` if you want to store them. Otherwise pass through pipeline only.

---

## GAP 5 — Format-Aware Article Structure

### What's missing
`generateArticleBody()` in `articleWriter.server.ts` uses one HTML structure for all articles. The `contentFormat` field exists in `BlogContentPlan` and is populated by `contentPlanner.server.ts` (formats: `listicle`, `comparison`, `evergreen-guide`, `technical`, `pro-tips`, `trend`) but is never used in the generation prompt.

### Prototype reference
**File:** `C:\projects\shopify-blog-automation\supabase\functions\shopify-blog-automation-ultra-seo\index.ts`  
Search for `FORMAT_INSTRUCTIONS` or `getFormatStructure`. Prototype injects format-specific rules into the article generation prompt:

**Listicle:**
- Numbered H2 items (e.g. "1. [Item Name]")
- Each item: problem + root cause + fix + impact sub-structure
- Summary comparison table at end
- "Key Takeaway" callout box every 3 items

**Comparison:**
- Feature comparison table (HTML `<table>`) near top
- H2 per feature category with "Winner: [A or B]" declaration
- Final Verdict section

**Evergreen Guide:**
- Seasonal framing only (no specific month)
- `<ol>` numbered steps inside H2 sections
- `<div class="pro-tip">` callout boxes
- Quick Start Checklist at end

**Technical:**
- Prerequisites section first
- `<pre><code>` blocks for any code/config
- Numbered implementation steps in `<ol>`

### What to change

**`app/services/blog/articleWriter.server.ts`:**  
Add helper:
```typescript
function getFormatInstructions(contentFormat: string): string { ... }
```
Returns format-specific HTML structure rules. Inject into `generateArticleBody()` prompt alongside existing instructions.

Map current categories to formats:
- `must-have-tools` → listicle
- `tool-comparison` → comparison  
- `technique-guide`, `product-guide`, `tool-care` → evergreen-guide
- `pro-tips`, `trend` → listicle

---

## GAP 6 — Image Generation

### What's missing
No image code exists in current app. Prototype generates a 16:9 header image per article using Google Gemini, uploads to storage, and attaches it to the Shopify article.

### Prototype reference
**File:** `C:\projects\shopify-blog-automation\supabase\functions\shopify-blog-image-generator\index.ts` (204 lines)

**Full flow:**
1. Query DB for one row with `image_status = 'pending'` AND `image_attempts < 3`
2. Increment `image_attempts` immediately (prevents parallel runs from picking same row)
3. Call Gemini `gemini-3-pro-image-preview`:
   ```
   prompt: "Create a blog header image about: {topic}. Style: minimalist dark aesthetic, professional, cinematic lighting, modern design. IMPORTANT: absolutely no text, no letters, no words in the image."
   aspectRatio: "16:9"
   ```
4. Parse base64 PNG from Gemini response
5. Upload to Supabase Storage → get public CDN URL
6. Call Shopify REST `PUT /articles/{id}` with `image: { src: cdnUrl, alt: topic }`
7. Set `image_status = 'done'`, store `image_url`
8. On error: if `image_attempts >= 3`, set `image_status = 'failed'`

**For current app, storage difference:** Use **Shopify Files API** instead of Supabase Storage:
```graphql
mutation FileCreate($files: [FileCreateInput!]!) {
  fileCreate(files: $files) {
    files { ... on MediaImage { image { url } } }
  }
}
```
Pass base64 as `originalSource` (Shopify accepts data URIs). Then use the returned URL in `articleUpdate`.

Or simpler: upload base64 PNG as buffer to any public CDN (e.g., Cloudflare R2, S3) and use the URL.

### DB changes needed
Add to `BlogContentPlan` in `prisma/schema.prisma`:
```prisma
imageUrl       String?
imageStatus    String?   @default("pending")
imageAttempts  Int       @default(0)
```

### New files needed

**`app/services/blog/imageGenerator.server.ts`:**
- `generateHeroImage(topic: string): Promise<Buffer>` — calls Gemini, returns PNG buffer
- `uploadImageToShopify(admin, imageBuffer, topic): Promise<string>` — uploads via Shopify Files API, returns URL
- `attachImageToArticle(admin, articleId, imageUrl, alt): Promise<void>` — `articleUpdate` mutation
- `processOneImageJob(admin, shop): Promise<void>` — full flow for one pending row

**`app/routes/api.cron.image.tsx`:**  
- POST endpoint, same `x-cron-secret` auth pattern as `api.cron.daily.tsx`
- Calls `processOneImageJob()` for each active shop
- Returns JSON with results

**`scripts/cron-runner.mjs`:**  
Add: every 5 minutes between 10:00–11:00 UTC → `POST /api/cron/image`
```js
cron.schedule('*/5 10-11 * * *', async () => { ... })
```

**`app/services/blog/articleWriter.server.ts` — `publishPlanItem()`:**  
After successful Shopify publish, set `imageStatus: 'pending'` on the `BlogContentPlan` row.

### Gemini API
Model: `gemini-2.0-flash-preview-image-generation` (current as of 2026; prototype used `gemini-3-pro-image-preview` which may have changed)  
Key env var: `GEMINI_API_KEY`  
SDK: `@google/generative-ai` npm package or direct REST call  
Response: `response.candidates[0].content.parts` — find part with `inlineData.mimeType = 'image/png'`, extract `inlineData.data` (base64)

---

## GAP 7 — Internal Linker

### What's missing
After articles are published, internal links between articles are never updated. The article generation prompt suggests internal links at write time, but as new articles are published, older articles don't link to them.

### Prototype reference
**File:** `C:\projects\shopify-blog-automation\supabase\functions\blog-internal-linker\index.ts` (831 lines)

**Full algorithm:**
1. `fetchAllArticles()` — paginated Shopify API fetch (prototype uses REST; current app uses GraphQL `getShopifyArticles()`)
2. `extractKeywords(title, tags)` — splits title into words (3+ chars, no stop words) + extracts bigrams/trigrams + splits tags on comma
3. Filter articles with < 3 internal links (`countInternalLinks(bodyHtml)` — counts `/blogs/` hrefs via regex)
4. For each article needing links: score candidates by `scoreRelevance()` (word overlap between article keywords and candidate keywords), take top 5 candidates
5. Call GPT-4o with article HTML (first 3,000 chars) + candidates list → returns `[{ anchorText, handle, surroundingContext }]` (2–3 suggestions)
6. Validate each suggestion: anchor is 2–6 words, exists in article text, not inside existing `<a>/<code>/<pre>` tags (`isInsideProtectedTag()`)
7. `insertLink(html, anchorText, href)` — find exact anchor text (case-insensitive fallback), wrap in `<a href='/blogs/{blogHandle}/{articleHandle}'>text</a>`
8. Service link: check if article links to `/pages/services` — if not, call GPT for one natural anchor, insert
9. Reverse linking: take top 5 newest articles, scan older articles for keyword mentions, insert reverse links
10. `updateArticle()` — Shopify API update with new body HTML

**Key guard:** `isInsideProtectedTag(html, position)` — checks if character position is inside `<a>`, `<code>`, or `<pre>` tags. Prevents nested anchors and broken code blocks.

### What to change

**New file `app/services/blog/internalLinker.server.ts`:**  
Port the algorithm above. Use existing `getShopifyArticles()` from `shopifyBlog.server.ts` for article fetching. Use Shopify GraphQL `articleUpdate` mutation for updates.

**New file `app/routes/api.cron.linker.tsx`:**  
POST endpoint with `x-cron-secret` auth. Runs linker for each active shop.

**`scripts/cron-runner.mjs`:**  
Add: weekly Sunday 12:00 UTC → `POST /api/cron/linker`

**GPT prompt for link suggestions** (from prototype):
```
You are an SEO expert. Given this article HTML and a list of candidate articles,
suggest 2-3 natural internal links. For each link, identify:
- anchorText: exact phrase from the article (2-6 words, naturally occurring)
- handle: the candidate article's Shopify handle
- surroundingContext: 10 words before and after to confirm location
Return JSON array only.
```

---

## GAP 8 — Article Refresher

### What's missing
Published articles are never updated. Articles with year references in titles (e.g. "Best Brushes for Contouring in 2025") become stale when the year changes.

### Prototype reference
**File:** `C:\projects\shopify-blog-automation\supabase\functions\blog-article-refresher\index.ts` (495 lines)

**Full algorithm:**
1. `fetchAllArticles()` — all published articles
2. `extractMonthYear(title)` — regex: `/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i`
3. `isArticleStale(month, year)` — stale if article's month/year < current month/year
4. `isArticleTooRecent(publishedAt)` — skip if published < 25 days ago
5. `callGPTForRefresh(title, bodyHtml, oldDate, newDate)`:
   - Pass: old article title, first 2000 chars of body, old `"Month Year"`, new `"Month Year"`
   - Returns JSON: `{ newTitle: string, updates: [{ oldText: string, newText: string }] }` (2–8 pairs)
   - Prompt: "Update time-sensitive references without changing structure, tone, or factual claims"
6. `applyContentUpdates(html, updates)` — string replacement for each pair
7. Blanket find-and-replace: remaining instances of old month/year string → new month/year string
8. `updateArticle(admin, articleId, newTitle, newHtml)`

**Adaptation for current app:**  
Current articles use year-only patterns ("in 2026") not month+year. Simplify staleness check: regex `/(20\d{2})/` in title, stale if year < current year. Blanket replace `"in {oldYear}"` → `"in {currentYear}"`.

### What to change

**New file `app/services/blog/articleRefresher.server.ts`**

**New file `app/routes/api.cron.refresh.tsx`**

**`scripts/cron-runner.mjs`:**  
Add: weekly Monday 08:30 UTC (before weekly plan at 09:00) → `POST /api/cron/refresh`

---

## Implementation Order (recommended)

1. **GAP 1** (metafields) — 30 min, immediate SEO win
2. **GAP 2** (retry cron) — 5 min, reliability
3. **GAP 4** (LSI keywords) — 1 hour, better article quality
4. **GAP 3** (Perplexity research) — 2–3 hours, requires new API key
5. **GAP 5** (format-aware structure) — 2–3 hours
6. **GAP 8** (article refresher) — 3–4 hours
7. **GAP 6** (image generation) — 1 day, requires Gemini key + storage decision
8. **GAP 7** (internal linker) — 1–2 days, most complex
