# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this app does

A Shopify embedded app that auto-generates and publishes SEO-optimized blog articles on a weekly schedule. It targets the ENCANTO brand (professional makeup tools, Spain/Europe/Gulf market, audience = professional MUAs).

## Project status

This app is a **prototype in active development**. A reference implementation (different codebase/stack) lives at `C:\projects\shopify-blog-automation` — useful for cross-referencing logic and feature parity.

This is a custom Shopify app installed on the ENCANTO makeup cosmetics store at **https://encantoshop.es/**. The store's own codebase (liquid theme) is at `C:\projects\CTR-enkanto`.

## Commands

```bash
npm run build        # React Router production build
npm run typecheck    # type-check (runs react-router typegen + tsc --noEmit)
npm run lint         # ESLint
npm run setup        # prisma generate + prisma migrate deploy (runs on deploy)
fly deploy --ha=false          # deploy to Fly.io
fly logs -a blog-generate      # stream live logs
fly ssh console -a blog-generate -C "<cmd>"  # run a command on the web machine
```

**Local dev is not working** — `npm run dev` (Shopify CLI tunnel) is broken in the current setup. All testing is done by deploying to Fly.io and verifying against the live store. Use `fly logs` for debugging and `fly ssh console` to run one-off commands (e.g. Prisma queries) on the production machine.

There are no unit tests. The app UI lives inside the Shopify admin (embedded iframe at `admin.shopify.com/store/drmtdf-we/apps/blog-generate`). Verification involves deploying, triggering a publish through the admin UI, then checking the resulting article on the storefront (encantoshop.es/blogs/noticias/...).

## Architecture

### Request flow

All admin UI routes live under `app/routes/app.*.tsx`. The parent `app/routes/app.tsx` calls `authenticate.admin(request)` which gates the entire subtree — any loader/action inside inherits the `admin` GraphQL client via `shopify.authenticate.admin(request)`.

Public (unauthenticated) routes are `/api/cron/*` — these are POST endpoints protected by `x-cron-secret` header only.

### Article generation pipeline (`app/services/blog/articleWriter.server.ts`)

`publishPlanItem(admin, planId, shop)` orchestrates five serial OpenAI calls:

1. `enrichKeywords()` — generates 8–12 SEO keywords for the topic
2. `researchTopic()` — creates a 250–350 word research brief
3. `generateArticleBody()` — writes the full HTML article (target 1800–2200 words, GPT-4o, maxTokens 5500)
4. `generateArticleMetadata()` — returns `{ title, metaDescription, tags, excerpt }` (GPT-4o JSON mode)
5. `publishArticleToShopify()` — writes to Shopify via Admin GraphQL `articleCreate`

Helper rules:
- `buildSeoTitle(title, brandName)` — appends `| ENCANTO` only when the result is ≤65 chars
- `truncateMetaDescription(text)` — hard-caps at 155 chars at word boundary (safety net for AI non-compliance)

### Shopify GraphQL (`app/services/blog/shopifyBlog.server.ts`)

Articles are created with `articleCreate(article: ArticleCreateInput!)`. SEO overrides use metafields:
- `namespace: "global", key: "title_tag"` — controls `{{ page_title }}` in the theme
- `namespace: "global", key: "description_tag"` — controls `<meta name="description">`

These are the standard Shopify SEO override metafields. `ArticleCreateInput` has **no native `seo` field** (unlike products/collections which have `SEOInput`).

### Scheduling

Two Fly.io processes run from `fly.toml`:
- `web` — the React Router app (`npm run start`)
- `cron` — `scripts/cron-runner.mjs` running `node-cron`, calls the app's own HTTP endpoints

Cron schedule:
- Monday 09:00 UTC → `POST /api/cron/weekly` → generates 7-article content plan via `generateWeeklyPlan()`
- Daily 10:00 UTC → `POST /api/cron/daily` → publishes today's planned article via `publishPlanItem()`

### Database (PostgreSQL via Prisma)

Two app-specific models:
- `BlogSettings` (one per shop) — stores `blogId`, `brandName`, `ctaUrl`, `servicesUrl`, `active` flag
- `BlogContentPlan` — one row per planned article; `status` progresses `planned → published | failed`; stores `articleId`, `articleUrl`, `keywords`, `errorMessage`

### UI

The app uses Shopify Polaris Web Components (`<s-page>`, `<s-banner>`, `<s-button>`, etc.) not React-based Polaris. Navigation is two pages: `/app/blog/plan` (content calendar + publish actions) and `/app/blog/settings`.

The `ICP_CONTEXT` constant in `articleWriter.server.ts` is injected into every OpenAI system prompt — it defines brand, audience, tone, and year context.

## Reading store data (preferred approach)

Use `shopify store execute` (Shopify CLI) to fetch article/product/blog data directly — it is faster and cheaper than browser automation. The admin session is always authenticated.

```bash
# Authenticate once (persists):
shopify store auth --store drmtdf-we.myshopify.com --scopes read_content,read_online_store_pages

# Fetch an article by ID:
shopify store execute --store drmtdf-we.myshopify.com \
  --query 'query GetArticle($id: ID!) { article(id: $id) { id title body summary } }' \
  --variables '{"id": "gid://shopify/Article/<ID>"}'
```

The article numeric ID comes from the Shopify admin URL: `.../content/articles/751050162501` → `gid://shopify/Article/751050162501`.

Use browser automation (`mcp__claude-in-chrome__*`) only when you need to interact with the UI (click buttons, fill forms, verify visual rendering) — not for reading data.

## Environment variables

Required at runtime:
- `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`
- `DATABASE_URL` — PostgreSQL connection string
- `OPENAI_API_KEY` — GPT-4o used for all generation
- `CRON_SECRET` — shared secret for `/api/cron/*` endpoints
