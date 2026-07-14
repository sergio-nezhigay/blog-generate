import type { BlogSettings } from "@prisma/client";
import db from "../../db.server";
import { chatComplete, chatCompleteJSON } from "./openai.server";
import { sonarComplete } from "./perplexity.server";
import { getShopifyArticles, publishArticleToShopify, uploadImageToShopifyCDN, setArticleHeroImage, getProductOrCollectionImage } from "./shopifyBlog.server";
import { enqueueTranslations } from "./translate.server";
import { getOpenAI } from "./openai.server";
import type { ShopifyArticle } from "./shopifyBlog.server";

export interface ProductLink {
  url: string;
  label: string;
  keywords: string;
}

type AdminGraphQL = (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;

const ICP_CONTEXT = `
Brand: ENCANTO — premium professional makeup tools (eyeshadow palettes, brushes, brow products, tweezers, sponges).
Audience: Professional makeup artists, beauty salon owners, aesthetics professionals, beauty school instructors,
and serious makeup enthusiasts in Spain, Europe, and the Gulf region.
Tone: Authoritative, professional, practical. Not beginner-focused. Not budget-focused.
Year: 2026.
ENCANTO sells TOOLS ONLY — brushes, tweezers, sponges, eyeshadow palettes. Never invent ENCANTO product names for foundations, lipsticks, eyeliners, mascaras, primers, or any cosmetics. For non-tool products write "a long-wear foundation" or "waterproof mascara" without an ENCANTO brand name.
NEVER invent statistics, percentages, surveys, or external reports out of thin air — only state factual claims that are explicitly present in research provided to you; otherwise use "many professional MUAs", "industry standard", "experienced artists prefer" instead.
`.trim();


async function enrichKeywords(topic: string, category: string): Promise<string[]> {
  const result = await chatCompleteJSON<{ keywords: string[] }>(
    [
      {
        role: "system",
        content: `You are an SEO specialist for a premium makeup tools brand. ${ICP_CONTEXT}`,
      },
      {
        role: "user",
        content: `Generate 8-12 SEO keywords for this blog article.
Title: "${topic}"
Category: ${category}

Include: primary keyword (close match to title), long-tail variations, professional makeup terms, 2026-relevant terms.

Respond with JSON: { "keywords": ["keyword1", "keyword2", ...] }`,
      },
    ],
    { temperature: 0.5, maxTokens: 300 },
  );
  return result.keywords ?? [];
}

async function researchTopic(topic: string, keywords: string[]): Promise<string> {
  try {
    return await sonarComplete(
      [
        {
          role: "system",
          content: `You are a research assistant for a premium professional makeup tools brand. ${ICP_CONTEXT}
Only report facts, trends, and practices you can verify from real sources. If you can't find a verifiable figure, describe the trend qualitatively instead of inventing a number.`,
        },
        {
          role: "user",
          content: `Write a detailed, factual research brief (250-350 words) for this blog article: "${topic}"

Cover:
- Key insights a professional MUA needs on this topic
- Common mistakes or misconceptions in the industry
- Professional standards and best practices
- Specific tool features or techniques relevant to the topic
- Current (2026) trends and market context, based on what you actually find

Keywords to weave in naturally: ${keywords.slice(0, 6).join(", ")}

This will be used to write the full article. Be specific and substantive.`,
        },
      ],
      { temperature: 0.4, maxTokens: 600 },
    );
  } catch (err) {
    console.error("[perplexity] researchTopic grounding failed, falling back to GPT-4o:", err instanceof Error ? err.message : err);
    return researchTopicGPT(topic, keywords);
  }
}

async function researchTopicGPT(topic: string, keywords: string[]): Promise<string> {
  return chatComplete(
    [
      {
        role: "system",
        content: `You are a professional makeup artist with 15 years of experience, expert in premium tools.
${ICP_CONTEXT}`,
      },
      {
        role: "user",
        content: `Write a detailed research brief (250-350 words) for this blog article: "${topic}"

Cover:
- Key insights a professional MUA needs on this topic
- Common mistakes or misconceptions in the industry
- Professional standards and best practices
- Specific tool features or techniques relevant to the topic
- 2026 trends and current market context

Keywords to weave in naturally: ${keywords.slice(0, 6).join(", ")}

This will be used to write the full article. Be specific and substantive.`,
      },
    ],
    { temperature: 0.7, maxTokens: 600 },
  );
}

function normalizeText(s: string): string {
  return s.toLowerCase()
    .replace(/[áàâä]/g, "a").replace(/[éèêë]/g, "e")
    .replace(/[íìîï]/g, "i").replace(/[óòôö]/g, "o")
    .replace(/[úùûü]/g, "u").replace(/ñ/g, "n").replace(/ç/g, "c");
}

export function selectRelevantArticles(
  topic: string,
  keywords: string[],
  articles: ShopifyArticle[],
  maxResults = 6,
): ShopifyArticle[] {
  const searchWords = [
    ...topic.split(/\s+/),
    ...keywords.flatMap((k) => k.split(/\s+/)),
  ].map(normalizeText).filter((w) => w.length > 3);
  const unique = [...new Set(searchWords)];

  const scored = articles.map((article) => {
    const titleWords = article.title.split(/\s+/).map(normalizeText);
    const score = unique.filter((term) =>
      titleWords.some((tw) => tw.includes(term) || term.includes(tw))
    ).length;
    return { article, score };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const da = a.article.publishedAt ? new Date(a.article.publishedAt).getTime() : 0;
    const db_ = b.article.publishedAt ? new Date(b.article.publishedAt).getTime() : 0;
    return db_ - da;
  });

  return scored.slice(0, maxResults).map((s) => s.article);
}

// Returns ALL productLinks ranked by relevance (best match first) — callers decide
// how many to actually use, since not every candidate is guaranteed to have a real image.
export function selectRelevantProductLinks(
  topic: string,
  keywords: string[],
  productLinks: ProductLink[],
): ProductLink[] {
  const searchWords = [
    ...topic.split(/\s+/),
    ...keywords.flatMap((k) => k.split(/\s+/)),
  ].map(normalizeText).filter((w) => w.length > 3);
  const unique = [...new Set(searchWords)];

  const scored = productLinks.map((link, idx) => {
    const linkWords = [
      ...link.label.split(/\s+/),
      ...link.keywords.split(/[,\s]+/),
    ].map(normalizeText).filter(Boolean);
    const score = unique.filter((term) =>
      linkWords.some((lw) => lw.includes(term) || term.includes(lw))
    ).length;
    return { link, score, idx };
  });

  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.idx - b.idx));

  return scored.map((s) => s.link);
}

async function generateArticleBody(
  topic: string,
  category: string,
  keywords: string[],
  research: string,
  linkCandidates: ShopifyArticle[],
  blogHandle: string,
  productLinks: ProductLink[],
  settings: BlogSettings,
): Promise<string> {
  const articleLinksBlock = linkCandidates.length > 0
    ? linkCandidates
        .map((a) => `- "${a.title}" → /blogs/${blogHandle}/${a.handle}`)
        .join("\n")
    : "No existing articles yet — omit internal article links.";

  const productLinksBlock = productLinks.length > 0
    ? productLinks
        .map((p) => `- "${p.label}" → ${p.url}`)
        .join("\n")
    : "";

  return chatComplete(
    [
      {
        role: "system",
        content: `You are an expert content writer producing SEO-optimized HTML blog articles for ${settings.brandName}.
${ICP_CONTEXT}

CRITICAL — WORD COUNT: The finished article MUST contain a minimum of 1800 words of readable text (excluding HTML tags), aiming for 2000+. This is non-negotiable. Write every section in full depth. Do not summarise or cut sections short. If you finish a section in fewer than 200 words, expand it with additional professional insights, examples, or nuance before moving on.

CRITICAL HTML RULES:
- Do NOT include <h1> (the theme provides it from the article title)
- Do NOT use <script>, <style>, or <link> tags
- Do NOT include JSON-LD or schema markup
- Use <h2 id="slug"> for main sections (slug = lowercase-hyphenated)
- Use <h3> for subsections, <p>, <ul>, <ol>, <strong>, <em> for content
- All h2 id attributes must be lowercase, hyphen-separated

INTERNAL ARTICLE LINKS — you MUST include exactly 2–4 of these links somewhere in the article body paragraphs. This is required, not optional:
${articleLinksBlock}
Anchor text: write a short natural phrase (3–6 words) that fits the sentence — do NOT copy the full title, do NOT repeat the same phrase twice.
${productLinksBlock.length > 0 ? `\nPRODUCT / COLLECTION LINKS — you MUST include exactly ${productLinks.length} of the following links, each exactly once, each as a natural anchor inside its own paragraph (do not put two of these links in the same paragraph or sentence). This is required, not optional:\n${productLinksBlock}\nAnchor text: use the label or a close natural variation, written to fit the sentence.` : ""}

CTA LINK: ${settings.ctaUrl}
COLLECTIONS LINK (use max 1 time): ${settings.servicesUrl}`,
      },
      {
        role: "user",
        content: `Write a complete, SEO-optimized HTML blog article. TARGET LENGTH: 1800–2200 words of readable text.

TITLE: "${topic}"
CATEGORY: ${category}
KEYWORDS: ${keywords.join(", ")}

RESEARCH CONTEXT:
${research}

REQUIRED STRUCTURE (output raw HTML only, no markdown):
1. <nav class="toc"><h3>In This Article</h3><ul>[<li><a href="#section-id">Section Name</a></li> for each H2]</ul></nav>
2. <p class="answer-first"><strong>[2-3 sentence direct answer to the title — optimized for AI/chatbot snippet citation]</strong></p>
3. <h2 id="introduction">Introduction</h2> — 150-200 words with a hook
4. [9-10 <h2> sections, EACH SECTION MINIMUM 200 words — write with depth, concrete examples, and professional insights; do not move to the next section until the current one reaches 200 words]
5. <h2 id="faq">Frequently Asked Questions</h2> — 5-7 Q&A using <details><summary>Question</summary><p>Answer</p></details>; each answer must be 2-4 sentences
6. <div class="cta-block"><p>Call to action paragraph linking to <a href="${settings.ctaUrl}">${settings.brandName}</a></p></div>

REMINDER: The total article must reach a minimum of 1800 words, targeting 2000+. Output only the HTML body content. No <html>, <head>, <body> tags. Start directly with <nav class="toc">.`,
      },
    ],
    { temperature: 0.7, maxTokens: 5500 },
  );
}

function buildSeoTitle(title: string, brandName: string): string {
  const branded = `${title} | ${brandName}`;
  return branded.length <= 65 ? branded : title;
}

function truncateMetaDescription(text: string): string {
  if (text.length <= 155) return text;
  const cut = text.slice(0, 152);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 100 ? cut.slice(0, lastSpace) : cut) + "...";
}

async function generateArticleMetadata(
  topic: string,
  bodyHtml: string,
  keywords: string[],
): Promise<{ title: string; metaDescription: string; tags: string[]; excerpt: string }> {
  const preview = bodyHtml.slice(0, 1500);
  return chatCompleteJSON<{
    title: string;
    metaDescription: string;
    tags: string[];
    excerpt: string;
  }>(
    [
      {
        role: "system",
        content: `You are an SEO specialist for a premium makeup tools brand. ${ICP_CONTEXT}
Write metadata that ranks in Google and earns clicks from professional makeup artists.`,
      },
      {
        role: "user",
        content: `Generate SEO metadata for this blog article.

Original title: "${topic}"
Primary keyword: ${keywords[0] ?? topic}
Article preview (first 1500 chars):
${preview}

Respond with JSON:
{
  "title": "Final SEO-optimized title (50-65 chars, includes primary keyword near the start)",
  "metaDescription": "Compelling meta description — MUST start with an action verb (Discover, Master, Learn, Explore), include primary keyword within first 20 words, answer the search intent, HARD MAX 155 chars, complete sentence, no truncation",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "excerpt": "Two-sentence article excerpt for blog listing page."
}`,
      },
    ],
    { temperature: 0.4, maxTokens: 400 },
  );
}

async function generateSingleImage(prompt: string): Promise<string> {
  const openai = getOpenAI();
  // gpt-image-2, high quality JPEG — higher cost than gpt-image-1/low, returns b64_json
  const resp = await openai.images.generate({
    model: "gpt-image-2",
    prompt: prompt.slice(0, 4000),
    n: 1,
    size: "1024x1024",
    quality: "high",
    output_format: "jpeg",
  });
  const b64 = resp.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI image generation returned no b64_json");
  return b64;
}

async function generateHeroImage(title: string): Promise<string> {
  const heroPrompt = `Professional studio product photo for: ${title.slice(0, 120)}. Clean neutral background, elegant arrangement. No text, no words, no letters. Soft studio lighting.`;
  return generateSingleImage(heroPrompt);
}

interface ImagePlacement {
  url: string;
  imageUrl: string;
  alt: string;
}

function normalizeHref(href: string): string {
  return href.trim().replace(/^https?:\/\/[^/]+/i, "").replace(/\/$/, "").toLowerCase();
}

function findEnclosingParagraphEnd(html: string, anchorIndex: number): number | null {
  const openIdx = html.lastIndexOf("<p", anchorIndex);
  if (openIdx === -1) return null;
  const prematureClose = html.indexOf("</p>", openIdx);
  if (prematureClose !== -1 && prematureClose < anchorIndex) return null;
  const closeIdx = html.indexOf("</p>", anchorIndex);
  if (closeIdx === -1) return null;
  return closeIdx + "</p>".length;
}

function positionalFallbackPoint(html: string, slot: number, totalSlots: number): number {
  const h2Closes = [...html.matchAll(/<\/h2>/gi)].map((m) => m.index! + m[0].length);
  if (h2Closes.length === 0) return html.length;
  const target = Math.min(h2Closes.length - 1, Math.floor(((slot + 1) * h2Closes.length) / (totalSlots + 1)));
  return h2Closes[target];
}

function injectProductImages(html: string, placements: ImagePlacement[]): string {
  const inserts: Array<{ at: number; tag: string }> = [];
  const anchorRe = /<a\s+[^>]*href="([^"]*)"[^>]*>/gi;

  placements.forEach((p, slot) => {
    const targetHref = normalizeHref(p.url);
    let anchorIndex = -1;
    for (const m of html.matchAll(anchorRe)) {
      if (normalizeHref(m[1]) === targetHref) {
        anchorIndex = m.index!;
        break;
      }
    }
    const alt = p.alt.replace(/"/g, "&quot;");
    const tag = `\n<a href="${p.url}"><img src="${p.imageUrl}" alt="${alt}" style="width:100%;border-radius:8px;margin:24px 0" loading="lazy"></a>`;

    let at: number | null = null;
    if (anchorIndex !== -1) at = findEnclosingParagraphEnd(html, anchorIndex);
    if (at === null) {
      console.warn(`[images] Link "${p.url}" not found as an anchor (or not inside a <p>) in generated HTML — using positional fallback`);
      at = positionalFallbackPoint(html, slot, placements.length);
    }
    inserts.push({ at, tag });
  });

  // Insert back-to-front so earlier insertions don't shift later insertion offsets
  inserts.sort((a, b) => b.at - a.at);
  let result = html;
  for (const { at, tag } of inserts) {
    result = result.slice(0, at) + tag + result.slice(at);
  }
  return result;
}

function sanitizeHTML(html: string): string {
  return html
    .trim()
    .replace(/^```(?:html)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .replace(/<h1[^>]*>[\s\S]*?<\/h1>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<link[^>]*>/gi, "");
}

function extractFaqItems(html: string): Array<{ q: string; a: string }> {
  const items: Array<{ q: string; a: string }> = [];
  const pattern = /<details[^>]*>[\s\S]*?<summary[^>]*>([\s\S]*?)<\/summary>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>[\s\S]*?<\/details>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const q = match[1].replace(/<[^>]+>/g, "").trim();
    const a = match[2].replace(/<[^>]+>/g, "").trim();
    if (q && a) items.push({ q, a });
  }
  return items;
}

function buildFaqPageSchemaJson(items: Array<{ q: string; a: string }>): string {
  const schema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map(({ q, a }) => ({
      "@type": "Question",
      name: q,
      acceptedAnswer: { "@type": "Answer", text: a },
    })),
  };
  return JSON.stringify(schema);
}

function restructureArticleLayout(html: string): string {
  const navMatch = html.match(/<nav\s+class="toc">[\s\S]*?<\/nav>/i);
  if (!navMatch) return html;

  const nav = navMatch[0];
  const beforeNav = html.slice(0, navMatch.index!);
  const afterNav = html.slice(navMatch.index! + nav.length);

  return `${beforeNav}<div class="article-layout"><aside class="article-toc">${nav}</aside><div class="article-body">${afterNav}</div></div>`;
}

export async function publishPlanItem(
  admin: { graphql: AdminGraphQL },
  planId: number,
  shop: string,
): Promise<void> {
  const plan = await db.blogContentPlan.findUnique({ where: { id: planId } });
  if (!plan) throw new Error("Plan item not found");
  if (plan.shop !== shop) throw new Error("Not authorized");
  if (plan.status === "published" || plan.status === "draft") throw new Error("Already published");
  if (plan.status === "generating") throw new Error("Generation already in progress");

  const settings = await db.blogSettings.findUnique({ where: { shop } });
  if (!settings?.blogId) throw new Error("No blog configured — go to Settings first.");

  await db.blogContentPlan.update({
    where: { id: planId },
    data: { status: "generating", generatingStartedAt: new Date() },
  });

  try {
    // 1. Keywords
    const keywords = await enrichKeywords(plan.topic, plan.category);

    // 2. Research
    const research = await researchTopic(plan.topic, keywords);

    // 3. Existing articles for internal links
    const { articles: existingArticles, blogHandle } = await getShopifyArticles(admin, settings.blogId);
    const linkCandidates = selectRelevantArticles(plan.topic, keywords, existingArticles);
    const productLinks = (settings.productLinks as unknown as ProductLink[]) ?? [];
    const rankedProductLinks = selectRelevantProductLinks(plan.topic, keywords, productLinks);

    // Walk ranked candidates fetching real images, stopping once 2 succeed. Some configured
    // URLs are storefront redirects (e.g. /collections/brochas -> /collections/brushes) that
    // don't resolve via Admin API handle lookup, so a candidate may score well but have no
    // image — in that case skip it and try the next-best candidate instead of losing a slot.
    const MAX_CANDIDATES_CHECKED = 6;
    const selectedProductLinks: Array<ProductLink & { imageUrl: string; imageAlt: string }> = [];
    for (const link of rankedProductLinks.slice(0, MAX_CANDIDATES_CHECKED)) {
      if (selectedProductLinks.length >= 2) break;
      const img = await getProductOrCollectionImage(admin, link.url);
      if (img) {
        selectedProductLinks.push({ ...link, imageUrl: img.imageUrl, imageAlt: img.altText || link.label });
      } else {
        console.warn(`[images] "${link.url}" has no resolvable image (may be a redirect/stale handle) — trying next candidate`);
      }
    }
    if (
      selectedProductLinks.length < 2 &&
      /^\/(products|collections)\//.test(settings.servicesUrl) &&
      !selectedProductLinks.some((l) => l.url === settings.servicesUrl)
    ) {
      const img = await getProductOrCollectionImage(admin, settings.servicesUrl);
      if (img) {
        selectedProductLinks.push({ url: settings.servicesUrl, label: "our collection", keywords: "", imageUrl: img.imageUrl, imageAlt: img.altText || "our collection" });
      }
    }

    // 4. Article body (HTML)
    const bodyHtml = await generateArticleBody(
      plan.topic,
      plan.category,
      keywords,
      research,
      linkCandidates,
      blogHandle,
      selectedProductLinks,
      settings,
    );

    // 5. Metadata
    const meta = await generateArticleMetadata(plan.topic, bodyHtml, keywords);

    // 6. Sanitize + restructure layout
    const safeHtml = restructureArticleLayout(sanitizeHTML(bodyHtml));

    // 7. Inject the pre-fetched product/collection images into the body, generate hero (non-blocking — article still publishes on failure)
    const TEST_PLACEHOLDER_IMAGE = "https://cdn.shopify.com/s/files/1/0931/1715/3605/files/article-image_ae12866e-ff85-453e-8126-c60b0982a430.jpg?v=1782118191";
    let finalBodyHtml = safeHtml;
    let heroImageUrl: string | null = null;
    try {
      // Body images already fetched above (step 3) — real product/collection CDN images,
      // cheap GraphQL reads that ran for real in test mode too (only the paid AI hero
      // generation below is mocked).
      const placements: ImagePlacement[] = selectedProductLinks.map((l) => ({
        url: l.url,
        imageUrl: l.imageUrl,
        alt: l.imageAlt,
      }));
      finalBodyHtml = injectProductImages(safeHtml, placements);

      if (settings.testMode) {
        // Skip OpenAI in test mode — use placeholder to avoid generation costs
        heroImageUrl = TEST_PLACEHOLDER_IMAGE;
      } else {
        const heroB64 = await generateHeroImage(plan.topic);
        heroImageUrl = await uploadImageToShopifyCDN(admin, heroB64, `${plan.topic} — ENCANTO`);
      }
    } catch (imgErr) {
      console.error("[images] Failed, continuing without images:", imgErr instanceof Error ? imgErr.message : imgErr);
    }

    // 8. Build FAQPage JSON-LD if article has a FAQ section (stored as a metafield —
    // Shopify strips <script> tags from article body, so it can't be embedded inline)
    const faqItems = extractFaqItems(finalBodyHtml);
    const faqSchemaJson = faqItems.length > 0 ? buildFaqPageSchemaJson(faqItems) : null;

    // 9. Publish to Shopify
    const displayTitle = (meta.title && meta.title.trim()) || plan.topic;
    const brandName = settings.brandName || "ENCANTO";
    const published = await publishArticleToShopify(admin, settings.blogId, {
      title: displayTitle,
      body_html: finalBodyHtml,
      summary_html: truncateMetaDescription(meta.metaDescription || ""),
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      published: !settings.testMode,
      authorName: brandName,
      seoTitle: buildSeoTitle(displayTitle, brandName),
      metaDescription: truncateMetaDescription(meta.metaDescription || ""),
      faqSchemaJson,
    });

    // 10. Set hero image on the published article
    if (heroImageUrl) {
      try {
        await setArticleHeroImage(admin, published.id, heroImageUrl, `${displayTitle} — ENCANTO`);
      } catch (heroErr) {
        console.error("[images] Failed to set hero image:", heroErr instanceof Error ? heroErr.message : heroErr);
      }
    }

    // Drafts link to the Shopify admin editor (storefront URL 404s for unpublished articles)
    // Live articles link directly to the storefront
    const numericId = published.id.split("/").pop();
    const shopSlug = shop.replace(".myshopify.com", "");
    const articleUrl = settings.testMode
      ? `https://admin.shopify.com/store/${shopSlug}/content/articles/${numericId}`
      : `https://${shop}/blogs/${published.blogHandle}/${published.handle}`;

    // 11. Update plan row
    await db.blogContentPlan.update({
      where: { id: planId },
      data: {
        status: settings.testMode ? "draft" : "published",
        generatingStartedAt: null,
        articleId: published.id,
        articleUrl,
        publishedAt: new Date(),
        keywords,
        errorMessage: null,
      },
    });

    // 12. Enqueue background translations (non-fatal — the English article is already live)
    await enqueueTranslations(planId, shop).catch((err) => {
      console.error(`[translate] enqueueTranslations failed for plan ${planId}:`, err);
    });
  } catch (err) {
    await db.blogContentPlan.update({
      where: { id: planId },
      data: {
        status: "failed",
        generatingStartedAt: null,
        errorMessage: err instanceof Error ? err.message : "Unknown error",
      },
    });
    throw err;
  }
}
