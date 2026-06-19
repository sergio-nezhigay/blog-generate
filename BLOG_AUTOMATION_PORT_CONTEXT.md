# Blog Automation Port — AI Development Context

> This document is written for an AI coding assistant. It contains the full context needed to implement blog automation functionality in the `blog-generate` Shopify TypeScript app, porting behavior from `shopify-blog-automation` (the Deno/Supabase reference app).

---

## Goal

Port the core blog automation features into the existing React Router 7 + Node.js Shopify app. The result should be a Shopify embedded app that automatically generates and publishes SEO-optimized blog articles via OpenAI, with a Polaris-based admin UI for managing the content pipeline.

---

## Current Project State

**Location:** `C:\projects\blog-generate`  
**Framework:** React Router 7.12.0 (full-stack, SSR on Node.js)  
**Language:** TypeScript 5.9.3 (strict mode)  
**ORM:** Prisma 6.16.3 → PostgreSQL  
**Shopify:** `@shopify/shopify-app-react-router` + GraphQL Admin API (2025-10)  
**Build:** Vite 6.3.6  
**Deployment:** Fly.io  
**UI:** Polaris Web Components (`<s-page>`, `<s-section>`, `<s-button>`, etc.)

### Key existing files

```
app/shopify.server.ts      — Shopify app init, authenticate.admin()
app/db.server.ts           — Prisma client singleton (use this, don't create another)
prisma/schema.prisma       — Currently has only the Session model
app/routes/app.tsx         — Authenticated admin shell with <s-app-nav> navigation
app/routes/app._index.tsx  — Example of loader + action + GraphQL mutation pattern
shopify.app.toml           — App manifest (scopes, webhooks, API version)
.env                       — Contains SHOPIFY_API_KEY, SHOPIFY_API_SECRET, DATABASE_URL
```

### How authentication works (critical to understand)

```typescript
// In any loader or action under /app/*:
const { admin, session } = await authenticate.admin(request);

// admin.graphql() makes authenticated calls to the Shopify Admin GraphQL API
const response = await admin.graphql(`
  query { shop { name } }
`);
```

The `session` object contains `session.shop` (the myshopify.com domain) and `session.accessToken`.  
The `authenticate.admin()` call handles OAuth, token refresh, and redirects automatically.

---

## What Needs to Be Built

### 1. Prisma Schema Changes

Add to `prisma/schema.prisma`:

```prisma
model BlogContentPlan {
  id              Int       @id @default(autoincrement())
  shop            String    // myshopify.com domain — scopes data per merchant
  weekStart       DateTime  @db.Date
  dayIndex        Int       // 0=Mon, 6=Sun
  scheduledDate   DateTime  @db.Date
  topic           String
  category        String
  contentFormat   String    // listicle | comparison | evergreen-guide | technical
  targetWordCount Int       @default(2000)
  keywords        String[]  @default([])

  status          String    @default("planned")  // planned | published | failed
  articleId       String?   // Shopify article GID
  articleUrl      String?
  publishedAt     DateTime?

  imageUrl        String?
  imageStatus     String?   @default("pending")  // pending | done | failed
  imageAttempts   Int       @default(0)

  errorMessage    String?   // last error if status=failed
  createdAt       DateTime  @default(now())

  @@index([shop, scheduledDate, status])
  @@index([shop, weekStart])
}
```

Run: `npx prisma migrate dev --name add_blog_content_plan`

### 2. New Environment Variables

Add to `.env` and Fly.io secrets:

```
OPENAI_API_KEY=           # gpt-4o + DALL-E 3 (images)
CRON_SECRET=              # Random string to protect cron endpoints
```

Note: The original used Perplexity + Gemini. For this port, use **OpenAI only**:
- `gpt-4o` for writing, keyword research, planning, internal linking, article refresh
- `gpt-4o` for image prompt generation + DALL-E 3 for image generation
  (or skip images initially and add later)

### 3. Required Shopify Scopes

Add to `shopify.app.toml` under `[access_scopes]`:
```toml
scopes = "write_products,write_metaobjects,write_metaobject_definitions,write_content,read_content"
```

`write_content` / `read_content` are needed for blog article CRUD via GraphQL Admin API.

### 4. New Route Files to Create

```
app/routes/app.blog.tsx              — Blog dashboard (list plans, stats)
app/routes/app.blog.plan.tsx         — Weekly content plan view + manual trigger
app/routes/app.blog.articles.tsx     — Published articles list with status
app/routes/app.blog.settings.tsx     — Store settings (brand, ICP, blog ID)
app/routes/api.cron.daily.tsx        — Protected cron endpoint (10:00 UTC)
app/routes/api.cron.weekly.tsx       — Protected cron endpoint (weekly plan)
app/routes/api.cron.images.tsx       — Protected cron endpoint (image queue)
```

### 5. Service Layer Files to Create

```
app/services/blog/openai.server.ts       — All OpenAI API calls
app/services/blog/contentPlanner.server.ts — Weekly plan generation
app/services/blog/articleWriter.server.ts  — Article generation pipeline
app/services/blog/imageGenerator.server.ts — DALL-E 3 image generation
app/services/blog/shopifyBlog.server.ts    — Shopify Blog GraphQL operations
app/services/blog/deduplication.server.ts  — Topic similarity scoring
```

---

## OpenAI Integration Approach

Use the official `openai` npm package:
```bash
npm install openai
```

All calls go through a singleton:

```typescript
// app/services/blog/openai.server.ts
import OpenAI from 'openai';

let openaiClient: OpenAI | null = null;

export function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}
```

**Model:** `gpt-4o` for all text generation  
**Temperature:** 0.7 (writing), 0.3 (keyword research, planning)  
**Response format:** `{ response_format: { type: 'json_object' } }` for structured outputs

---

## Shopify Blog API (GraphQL)

The reference app used REST. This port uses GraphQL (already configured in the project).

### Create article (publish)
```graphql
mutation BlogArticleCreate($blogId: ID!, $article: ArticleCreateInput!) {
  articleCreate(blogId: $blogId, article: $article) {
    article {
      id
      handle
      onlineStoreUrl
    }
    userErrors { field message }
  }
}
```

### List existing articles (for deduplication)
```graphql
query BlogArticles($blogId: ID!) {
  blog(id: $blogId) {
    articles(first: 250) {
      nodes {
        id
        title
        handle
        tags
      }
    }
  }
}
```

### Update article (add image, update links)
```graphql
mutation ArticleUpdate($id: ID!, $article: ArticleUpdateInput!) {
  articleUpdate(id: $id, article: $article) {
    article { id }
    userErrors { field message }
  }
}
```

**Blog GID format:** `gid://shopify/Blog/123456789`  
**Article GID format:** `gid://shopify/Article/987654321`

To get the blog ID: admin → Online Store → Blog posts → note the URL `/blogs/news` or use GraphQL:
```graphql
query { blogs(first: 10) { nodes { id title } } }
```

---

## Cron Scheduling Strategy

**Pattern:** Protected HTTP endpoints called by an external cron service.

This is the standard Shopify app pattern (confirmed by Shopify's subscriptions reference app).

### Protected cron endpoint structure

```typescript
// app/routes/api.cron.daily.tsx
export async function action({ request }: ActionFunctionArgs) {
  // Verify secret to prevent unauthorized calls
  const secret = request.headers.get('x-cron-secret');
  if (secret !== process.env.CRON_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }
  
  // Run for a specific shop (passed in body or hardcoded for single-store)
  const { shop } = await request.json();
  await runDailyBlogAutomation(shop);
  
  return Response.json({ ok: true });
}
```

### Cron triggers

Use **cron-job.org** (free) or **GitHub Actions scheduled workflows** to call:
- `POST https://blog-generate.fly.dev/api/cron/daily` at 10:00 UTC daily
- `POST https://blog-generate.fly.dev/api/cron/weekly` at 09:00 UTC on Mondays
- `POST https://blog-generate.fly.dev/api/cron/images` every 5 min (or simpler: call after daily publish)

Header: `x-cron-secret: <CRON_SECRET value>`

Alternatively for Fly.io: use Fly Machines with a scheduled run command.

---

## Content Generation Pipeline (per-article)

Implement this sequence in `articleWriter.server.ts`:

```
1. loadExistingArticles(shop, blogId)     → string[] of titles + handles
2. getTodaysPlan(shop, today)             → BlogContentPlan row
3. enrichKeywords(topic, category)        → string[] via gpt-4o
4. researchTopic(topic, keywords)         → string (research context) via gpt-4o
5. generateArticle(topic, keywords, research, existingArticles) → ArticleJSON via gpt-4o
6. sanitizeHTML(content)                  → remove <h1>, <script>
7. publishToShopify(admin, blogId, article) → { id, url }
8. updatePlanRow(id, { status: 'published', articleId, articleUrl, publishedAt })
```

### Article JSON schema (what gpt-4o must return)

```typescript
interface ArticleOutput {
  title: string;           // 50-60 chars, include primary keyword
  metaDescription: string; // 150-160 chars
  content: string;         // Full HTML — see structure below
  excerpt: string;         // 155 chars for social
  keywords: string[];      // 5-10 terms
  internalLinks: string[]; // Handles of existing articles to link to
  readingTime: number;     // Minutes
}
```

### Required HTML structure in `content` field

```html
<!-- Answer-first block (2-3 sentences, AI citation optimized) -->
<p><strong>[Direct answer to the implied question in the title]</strong></p>

<!-- Introduction: 150-200 words -->
<p>...</p>

<!-- Table of contents -->
<nav><ul><li><a href="#section-1">Section Title</a></li>...</ul></nav>

<!-- 7-10 H2 sections, 150-200 words each -->
<h2 id="section-1">Section Title</h2>
<p>...</p>

<!-- FAQ (5-7 questions) -->
<h2>Frequently Asked Questions</h2>
<details><summary>Question?</summary><p>Answer</p></details>

<!-- CTA block -->
<div class="cta-block">
  <p>Ready to optimize your Shopify store? <a href="/pages/contact">Get a free audit →</a></p>
</div>
```

**Constraints to enforce in the prompt:**
- No `<h1>` tags (theme adds the title)
- No `<script>` tags
- No JSON-LD (theme handles structured data)
- Max 2 links to `/pages/services`
- 3-5 internal links to existing articles (by handle, must exist in `existingArticles`)
- Include at least one data point / statistic per section

---

## Weekly Planning Pipeline

Implement in `contentPlanner.server.ts`:

```typescript
const CONTENT_CATEGORIES = [
  { dayIndex: 0, name: 'store-problems',    format: 'listicle',       titlePattern: 'X Problems Shopify Store Owners Face (And How to Fix Them)' },
  { dayIndex: 1, name: 'tool-comparison',   format: 'comparison',     titlePattern: 'X vs Y: Which Is Better for Shopify Stores in 2026?' },
  { dayIndex: 2, name: 'migration-guide',   format: 'evergreen-guide', titlePattern: 'How to [Migrate/Move] Your Shopify Store to [Platform] in 2026' },
  { dayIndex: 3, name: 'cro-revenue',       format: 'evergreen-guide', titlePattern: 'X Ways to Increase Shopify Conversion Rate in 2026' },
  { dayIndex: 4, name: 'hiring-agencies',   format: 'evergreen-guide', titlePattern: 'How to Hire a Shopify [Expert/Agency] in 2026: Complete Guide' },
  { dayIndex: 5, name: 'platform-decision', format: 'comparison',     titlePattern: 'Shopify [Plan/Feature] vs [Alternative]: Which Should You Choose?' },
  { dayIndex: 6, name: 'technical-guide',   format: 'technical',      titlePattern: 'How to [Technical Task] in Shopify: Step-by-Step Guide 2026' },
];
```

### ICP filter to embed in every planning/writing prompt

```
TARGET AUDIENCE: Owners and managers of established Shopify stores generating $10,000–$500,000+ 
per month in revenue. They hire agencies, outsource development, and face real operational 
problems at scale.

REJECT these topics: consumer shopping guides, dropshipping tutorials, "best products to sell", 
gadget listicles, beginner "how to start a store" content.

INCLUDE: Agency hiring, store migrations, CRO at scale, technical Shopify features, 
platform comparisons for businesses already committed to Shopify.
```

### Deduplication algorithm

```typescript
function computeSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  return intersection / Math.max(wordsA.size, wordsB.size);
}

// Reject if similarity > 0.3 against any existing title or planned topic
```

---

## Admin UI Routes

### Navigation (add to `app/routes/app.tsx`)

Add navigation links to the existing `<s-app-nav>`:
```tsx
<s-app-nav-link url="/app/blog">Blog Automation</s-app-nav-link>
```

### `app/routes/app.blog.tsx` — Dashboard

**Loader:** Query `BlogContentPlan` for this week's rows + counts of published/planned/failed.  
**UI:** 
- Stats cards: articles this week, published, pending, failed
- Quick action buttons: "Generate weekly plan", "Publish today's article"
- Link to full plan view

### `app/routes/app.blog.plan.tsx` — Content Plan

**Loader:** Query all `BlogContentPlan` rows for the last 4 weeks.  
**Action:** Handle `generatePlan` and `publishToday` form submissions.  
**UI:** 
- Table: date | category | topic | status | article link
- "Generate Plan" button (runs weekly planning pipeline)
- "Publish Now" button per row (runs article generation for that row)

### `app/routes/app.blog.settings.tsx` — Settings

**Model:** Store per-shop settings in a new `BlogSettings` Prisma model:
```prisma
model BlogSettings {
  id          Int    @id @default(autoincrement())
  shop        String @unique
  blogId      String // Shopify Blog GID
  brandName   String @default("")
  icpFilter   String @default("")  // Custom ICP description (optional override)
  ctaUrl      String @default("/pages/contact")
  servicesUrl String @default("/pages/services")
  active      Boolean @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

**UI:** Form to set blog ID, brand name, CTA URLs, toggle automation on/off.

---

## Branding Replacement

The reference app has MILEDEVS-specific content hardcoded in prompts. When implementing prompts in this port, replace with:

| Reference app | This port |
|---|---|
| `MILEDEVS` | Read from `BlogSettings.brandName` (or env var `BRAND_NAME`) |
| `/pages/contact` | Read from `BlogSettings.ctaUrl` |
| `/pages/services` | Read from `BlogSettings.servicesUrl` |
| LUNESI, RINFIT, CARBON, JOYFOLIE case studies | Remove or replace with configurable examples |
| "Shopify development agency" ICP | Keep as default, allow override via `BlogSettings.icpFilter` |

---

## File Creation Order (recommended implementation sequence)

1. **Prisma schema** — Add `BlogContentPlan` + `BlogSettings` models, run migration
2. **`app/services/blog/openai.server.ts`** — OpenAI client + helper functions
3. **`app/services/blog/shopifyBlog.server.ts`** — GraphQL queries/mutations for blogs
4. **`app/services/blog/deduplication.server.ts`** — Similarity scoring
5. **`app/services/blog/contentPlanner.server.ts`** — Weekly plan generation
6. **`app/services/blog/articleWriter.server.ts`** — Full article generation pipeline
7. **`app/routes/api.cron.daily.tsx`** — Protected cron endpoint
8. **`app/routes/api.cron.weekly.tsx`** — Protected cron endpoint
9. **`app/routes/app.blog.settings.tsx`** — Settings UI (needed before automation can run)
10. **`app/routes/app.blog.plan.tsx`** — Plan management UI
11. **`app/routes/app.blog.tsx`** — Dashboard

---

## Important Patterns From the Reference App to Preserve

1. **Idempotency:** Before publishing, always check if today's article is already published (`status = 'published'` in DB + cross-check Shopify).
2. **Error capture:** Store errors in `BlogContentPlan.errorMessage` so the UI can show what went wrong without losing the row.
3. **Answer-first block:** Every article must start with a 2-3 sentence direct answer. This is the #1 SEO feature.
4. **HTML sanitization:** Strip `<h1>`, `<script>`, and any `<style>` from generated content before publishing.
5. **Internal link validation:** Only insert internal links to articles confirmed to exist (check against fetched article handles list).
6. **Table of contents:** Must be generated from the actual H2 IDs in the content (not hallucinated by the LLM).

---

## What Is NOT Being Ported

| Feature | Reason |
|---|---|
| Perplexity research | Replacing with gpt-4o (OpenAI only per user preference) |
| Google Gemini images | Replace with DALL-E 3 via OpenAI, or skip in v1 |
| Supabase Storage | Not needed — store image URL directly from DALL-E response |
| pg_cron scheduler | Replaced with HTTP cron endpoint pattern |
| Shopify theme files | The theme already exists on the store; not part of this app |
| blog-internal-linker | Port as a manual action button in the UI (Phase 2) |
| blog-article-refresher | Port as a manual action button in the UI (Phase 2) |

---

## Quick Reference: Existing Patterns to Follow

### Pattern: loader + action in React Router 7

```typescript
// app/routes/app.blog.plan.tsx
import { authenticate } from '../shopify.server';
import db from '../db.server';

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const plans = await db.blogContentPlan.findMany({
    where: { shop: session.shop },
    orderBy: { scheduledDate: 'desc' },
    take: 28,
  });
  return { plans };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get('intent');
  
  if (intent === 'generatePlan') {
    await generateWeeklyPlan(session.shop, admin);
    return { success: true, message: 'Plan generated' };
  }
  // ...
};
```

### Pattern: GraphQL call

```typescript
const response = await admin.graphql(`
  query GetBlog($id: ID!) {
    blog(id: $id) {
      articles(first: 250) {
        nodes { id title handle }
      }
    }
  }
`, { variables: { id: blogId } });

const { data } = await response.json();
```
