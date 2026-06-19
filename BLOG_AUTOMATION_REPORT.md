# Blog Automation App — How It Works

> Human-readable breakdown of `shopify-blog-automation` (the reference implementation).

---

## What It Does

A fully autonomous AI content engine that publishes one SEO-optimized blog article per day to a Shopify store — with zero human input after setup. It plans a week of topics on Sunday, researches and writes each article daily, generates a header image, and optionally adds cross-links and refreshes older content.

**Cost:** ~$3–5/day in AI API calls.  
**Output:** 1 article/day, 1800–2200 words, published directly to Shopify.

---

## Tech Stack (Reference App)

| Layer | Technology |
|---|---|
| Runtime | Supabase Edge Functions (Deno/TypeScript) |
| Scheduler | pg_cron + pg_net (runs inside Postgres) |
| Database | Supabase Postgres (1 table) |
| AI: Writing | OpenAI gpt-4o |
| AI: Research & Planning | Perplexity sonar |
| AI: Images | Google Gemini (`gemini-3-pro-image-preview`) |
| Image Storage | Supabase Storage |
| Shopify API | Admin REST API v2024-10 |

---

## Architecture: 4 Independent Functions

```
[pg_cron @ 10:00 UTC] ──► shopify-blog-automation-ultra-seo   (main: plan + write + publish)
[pg_cron every 5min]  ──► shopify-blog-image-generator        (image pickup queue)
[Manual trigger]      ──► blog-internal-linker                (add cross-links)
[Manual trigger]      ──► blog-article-refresher              (refresh stale month/year)
```

---

## Main Data Flow

### Step 1 — Weekly Planning (runs once per week, on the first Sunday)

Triggered by the daily function. Checks if a plan already exists for this week. If not:

1. Calls **Perplexity sonar** with a prompt describing 7 content categories (one per weekday)
2. Perplexity returns 7 trending, real-world topics with SEO titles
3. Each topic is scored for similarity against existing articles + past plans (word-overlap algorithm)
4. Duplicates are filtered, regenerated if needed
5. Topics saved to `blog_content_plan` table with `status = 'planned'`

**7 Content Categories (one per weekday):**
- Monday: Listicle (store problems & fixes)
- Tuesday: Comparison (tools/platforms)
- Wednesday: Evergreen guide (migration/replatforming)
- Thursday: Evergreen guide (CRO & revenue)
- Friday: Evergreen guide (hiring/agencies)
- Saturday: Comparison (platform/plan decisions)
- Sunday: Technical guide

### Step 2 — Daily Article Generation (10:00 UTC every day)

1. Reads today's planned topic from `blog_content_plan`
2. Calls **OpenAI gpt-4o** to enrich with commercial-intent keywords
3. Calls **Perplexity sonar** to deep-research the topic (real facts, no hallucinations, 2026 data)
4. Calls **OpenAI gpt-4o** to write the full article as structured JSON

**Article JSON output format:**
```json
{
  "title": "50-60 char SEO title",
  "metaDescription": "150-160 chars with primary keyword",
  "content": "Full HTML — see structure below",
  "excerpt": "155 char social teaser",
  "keywords": ["kw1", "kw2"],
  "internalLinks": ["article-handle-1", "article-handle-2"],
  "readingTime": 10
}
```

5. HTML content is sanitized (removes `<h1>`, `<script>`, JSON-LD — theme handles those)
6. Published to Shopify via `POST /admin/api/2024-10/blogs/{blog_id}/articles.json`
7. Row updated: `status = 'published'`, `article_id = <shopify_id>`, `image_status = 'pending'`
8. A retry at 11:00 UTC is a no-op if already published (idempotent)

### Step 3 — Image Generation (every 5 min during 10–11 UTC)

1. Queries for rows where `status = 'published'` AND `image_status = 'pending'` AND `image_attempts < 3`
2. Calls **Google Gemini** to generate a 16:9 header image (dark minimalist, no text)
3. Uploads image to Supabase Storage
4. Attaches image to Shopify article via `PUT /admin/api/.../articles/{id}.json`
5. Sets `image_status = 'done'` or increments `image_attempts` on failure

---

## Article HTML Structure (what gpt-4o is instructed to produce)

```
[Answer-first block]   — 2-3 sentences. Direct answer optimized for AI chatbot citation.
[Introduction]         — 150-200 words
[Table of contents]    — Anchor links to all H2s
[H2 section × 7-10]   — 150-200 words each
[Internal links × 3-5] — To existing blog posts (by handle, GPT picks natural anchor text)
[FAQ section]          — 5-7 questions in HTML <details> accordion
[CTA block]            — Links to /pages/contact (free audit offer)
```

**Conversion rules baked into the prompt:**
- Max 1-2 links to `/pages/services`
- Reference real case studies (LUNESI, RINFIT, CARBON, JOYFOLIE) where relevant
- Never link externally (except for citations)
- Every article ends with a CTA to `/pages/contact`

---

## Content Strategy (ICP Filter)

Every prompt includes this filter:  
> "Target: owners/managers of established Shopify stores ($10k–$500k+/month revenue) who hire agencies. Reject: consumer shopping content, dropshipping guides, gadget listicles."

This is the single most important part of the content system. It gates every topic decision.

---

## Database Schema (1 table)

```sql
blog_content_plan (
  id               BIGINT PRIMARY KEY,
  week_start       DATE,        -- Monday of the plan week
  day_index        INT,         -- 0=Mon .. 6=Sun
  scheduled_date   DATE,        -- Publishing date
  topic            TEXT,        -- Article title/topic
  category         TEXT,        -- One of 7 categories
  content_format   TEXT,        -- listicle | comparison | evergreen-guide | technical
  target_word_count INT,        -- 1800–2200
  keywords         TEXT[],      -- Extracted keywords
  
  status           TEXT,        -- 'planned' | 'published'
  article_id       BIGINT,      -- Shopify article ID after publishing
  article_url      TEXT,
  published_at     TIMESTAMPTZ,
  
  image_url        TEXT,
  image_status     TEXT,        -- 'pending' | 'done' | 'failed'
  image_attempts   INT,         -- Max 3
  
  created_at       TIMESTAMPTZ
)
```

---

## Shopify API Usage

| Operation | Endpoint |
|---|---|
| Fetch all articles | `GET /admin/api/2024-10/blogs/{id}/articles.json` |
| Publish article | `POST /admin/api/2024-10/blogs/{id}/articles.json` |
| Update article (image, links) | `PUT /admin/api/2024-10/articles/{id}.json` |
| Auth token | `POST https://{store}/admin/oauth/access_token` (client_credentials grant) |

Auth token is cached in-memory with a 1-hour safety margin before expiry.

---

## Optional Functions

### Internal Linker
- Finds articles with fewer than 3 internal links
- Calls gpt-4o to find natural anchor text from existing article content
- Inserts `<a href>` links safely (skips if inside `<a>`, `<code>`, `<pre>`)
- Also backlinks newest 5 articles from older 20 articles
- Max 3 links added per article, 5 articles processed per run

### Article Refresher
- Finds articles with a stale "Month Year" in the title (e.g., "January 2025 Guide")
- Calls gpt-4o to generate targeted replacements for outdated month/year references
- Applies exact string replacement (no full rewrite)
- Only processes articles ≥25 days old, max 3 per run

---

## Shopify Theme Layer (25 files)

Not part of the automation logic — these are theme files for the reader experience:
- `seo-schema.liquid` — JSON-LD structured data (Article, BreadcrumbList, Organization)
- `meta-tags.liquid` — OG/Twitter meta, canonical URL
- `main-article.liquid` — Article renderer with sticky TOC, scroll-spy, dark theme (#0a0a0a + lime #d4ff00)
- `main-blog.liquid` — Blog index
- `article-card.liquid` — Post card component

---

## Environment Variables

```
OPENAI_API_KEY        # gpt-4o
PERPLEXITY_API_KEY    # sonar API
GEMINI_API_KEY        # image generation
SHOPIFY_STORE_URL     # your-store.myshopify.com (host only, no https)
SHOPIFY_CLIENT_ID     # from Shopify custom app
SHOPIFY_CLIENT_SECRET
SHOPIFY_BLOG_ID       # numeric blog ID from Shopify
SUPABASE_URL          # auto-injected to edge functions
SUPABASE_SERVICE_ROLE_KEY
```

---

## Key Design Decisions Worth Preserving in the Port

1. **Deduplication is 3-layer**: compare against (a) existing published articles, (b) past planned topics, (c) similarity score > 0.3 threshold → regenerate
2. **State machine in DB**: every step (planned → published → image done) is tracked in the DB row, making the system resumable and idempotent
3. **Perplexity for planning/research, OpenAI for writing**: Perplexity prevents hallucinations in statistics/facts; OpenAI structures the prose
4. **Answer-first block**: the most important structural rule — optimizes for AI chatbot citation (ChatGPT, Perplexity answers)
5. **Retry is a no-op**: the 11:00 UTC retry simply checks `isTodayAlreadyPublished()` and exits — safe to run multiple times
6. **Image generation is decoupled**: runs separately every 5 min, so a failed image never blocks publishing
