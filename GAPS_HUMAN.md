# Feature Gaps: blog-generate vs Prototype

> Short reference for human review. Gaps found by comparing current app against `shopify-blog-automation` prototype.  
> AI implementation guide → `GAPS_AI_CONTEXT.md`

---

## Already Complete (no action)

- Weekly content calendar (7 topics, category rotation)
- Article pipeline: keywords → research → write → metadata
- Deduplication vs existing Shopify articles
- Daily + weekly cron automation on Fly.io
- `planned / published / failed` status + retry logic
- ICP filtering in prompts

---

## Gaps — Ordered by Effort vs. Impact

### 🟢 Quick Wins (small effort, real SEO impact)

**1. SEO Metafields**  
Google reads the `<title>` and `<meta name="description">` from Shopify metafields (`seo.title`, `seo.description`) — not from the article title or summary fields. We generate both values already but never send them to Shopify. Without this, Google picks whatever it wants for title/description.  
*Files:* `shopifyBlog.server.ts`, `articleWriter.server.ts`

**2. Retry cron at 11:00 UTC**  
Single daily run means a transient OpenAI/Shopify timeout = missed article until tomorrow. Add a second cron at 11:00 UTC pointing at the same `/api/cron/daily` endpoint — it's already idempotent (skips if already published).  
*Files:* `scripts/cron-runner.mjs`

**3. LSI Keywords in keyword enrichment**  
Prototype generates primary keywords + LSI (semantically related) keywords separately. LSI keywords woven through article body signal topical depth to Google. Currently we generate a flat keyword list with no distinction.  
*Files:* `articleWriter.server.ts`

---

### 🟡 Medium (worthwhile, 1–2 days each)

**4. Perplexity AI for research step**  
Prototype uses Perplexity `sonar` (live internet search) for the deep research step instead of GPT-4o. GPT-4o invents statistics; Perplexity pulls real data with citations. Also used for weekly planning to catch current trends. Requires `PERPLEXITY_API_KEY` secret.  
*Files:* new `perplexity.server.ts`, `articleWriter.server.ts`

**5. Format-aware article structure**  
The `contentFormat` field exists in the DB (listicle, comparison, guide, technical) but the generation prompt is identical for all formats. Prototype varies structure significantly: listicle gets numbered H2s + summary table, comparison gets feature table + winner declarations, guide gets `<ol>` steps + Pro Tip boxes, technical gets `<pre><code>` blocks.  
*Files:* `articleWriter.server.ts`

**6. Article Refresher**  
Weekly pass that detects articles with stale year references in titles (e.g. "Best Tools in 2025"), asks GPT to update the title and relevant date/stat phrases to the current year. Keeps older content evergreen. Prototype runs weekly on Mondays.  
*Files:* new `articleRefresher.server.ts`, new `api.cron.refresh.tsx`, `cron-runner.mjs`

---

### 🔴 Larger (high value, 3–5 days each)

**7. Image Generation**  
Prototype generates a 16:9 hero image per article using Google Gemini image model — minimalist dark background, NO text in image. Uploads to storage (Supabase in prototype; Shopify Files API is cleaner for us), then attaches to Shopify article. Runs as a separate cron job (every 5 min in 10–11 UTC window) so it doesn't block article publishing. Uses `imageStatus: pending → done / failed` tracking in DB with 3-attempt cap.  
*Files:* new `imageGenerator.server.ts`, new `api.cron.image.tsx`, `schema.prisma` (add image fields), `cron-runner.mjs`

**8. Internal Linker**  
Post-publish pass that reads all published articles, finds ones with fewer than 3 internal links, and uses GPT to identify natural anchor text opportunities pointing to topically related articles. Also adds a `/pages/services` link if missing, and reverse-links newer articles from older ones that mention them. Runs weekly. Significant SEO value (internal link equity distribution).  
*Files:* new `internalLinker.server.ts`, new `api.cron.linker.tsx`, `cron-runner.mjs`

---

## Decision Checklist

- [ ] Confirm which AI models to add (Perplexity? Gemini for images?)
- [ ] Image storage: Shopify Files API (simplest) vs external CDN?
- [ ] Article refresher scope: year-only or also fact-refresh via Perplexity?
- [ ] Internal linker: run on all articles or only new ones?
