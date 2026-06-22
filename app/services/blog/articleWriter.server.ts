import type { BlogSettings } from "@prisma/client";
import db from "../../db.server";
import { chatComplete, chatCompleteJSON } from "./openai.server";
import { getShopifyArticles, publishArticleToShopify, uploadImageToShopifyCDN, setArticleHeroImage } from "./shopifyBlog.server";
import { getOpenAI } from "./openai.server";
import type { ShopifyArticle } from "./shopifyBlog.server";

type AdminGraphQL = (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;

const ICP_CONTEXT = `
Brand: ENCANTO — premium professional makeup tools (eyeshadow palettes, brushes, brow products, tweezers, sponges).
Audience: Professional makeup artists, beauty salon owners, aesthetics professionals, beauty school instructors,
and serious makeup enthusiasts in Spain, Europe, and the Gulf region.
Tone: Authoritative, professional, practical. Not beginner-focused. Not budget-focused.
Year: 2026.
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

async function generateArticleBody(
  topic: string,
  category: string,
  keywords: string[],
  research: string,
  existingArticles: ShopifyArticle[],
  settings: BlogSettings,
): Promise<string> {
  const internalLinksContext = existingArticles.length > 0
    ? existingArticles.slice(0, 15)
        .map((a) => `- "${a.title}" → /blogs/news/${a.handle}`)
        .join("\n")
    : "No existing articles yet — omit internal links.";

  return chatComplete(
    [
      {
        role: "system",
        content: `You are an expert content writer producing SEO-optimized HTML blog articles for ${settings.brandName}.
${ICP_CONTEXT}

CRITICAL HTML RULES:
- Do NOT include <h1> (the theme provides it from the article title)
- Do NOT use <script>, <style>, or <link> tags
- Do NOT include JSON-LD or schema markup
- Use <h2 id="slug"> for main sections (slug = lowercase-hyphenated)
- Use <h3> for subsections, <p>, <ul>, <ol>, <strong>, <em> for content
- All h2 id attributes must be lowercase, hyphen-separated

INTERNAL LINKS (use 3-5 if relevant):
${internalLinksContext}

CTA LINK: ${settings.ctaUrl}
COLLECTIONS LINK (use max 2 times): ${settings.servicesUrl}`,
      },
      {
        role: "user",
        content: `Write a complete, SEO-optimized HTML blog article.

TITLE: "${topic}"
CATEGORY: ${category}
TARGET: 1800–2200 words
KEYWORDS: ${keywords.join(", ")}

RESEARCH CONTEXT:
${research}

REQUIRED STRUCTURE (output raw HTML only, no markdown):
1. <p class="answer-first"><strong>[2-3 sentence direct answer to the title — optimized for AI/chatbot snippet citation]</strong></p>
2. <h2 id="introduction">Introduction</h2> — 150-200 words with a hook
3. <nav class="toc"><h3>In This Article</h3><ul>[<li><a href="#section-id">Section Name</a></li> for each H2]</ul></nav>
4. [7-10 <h2> sections, each 150-200 words, with at least one specific statistic, data point, or concrete example]
5. <h2 id="faq">Frequently Asked Questions</h2> — 5-7 Q&A using <details><summary>Question</summary><p>Answer</p></details>
6. <div class="cta-block"><p>Call to action paragraph linking to <a href="${settings.ctaUrl}">${settings.brandName}</a></p></div>

Output only the HTML body content. No <html>, <head>, <body> tags. Start directly with <p class="answer-first">.`,
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

function extractH2Headings(html: string): string[] {
  const matches = [...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/gi)];
  return matches.map(m => m[1].replace(/<[^>]+>/g, "").trim());
}

async function generateSingleImage(prompt: string): Promise<string> {
  const openai = getOpenAI();
  // DEBUG: gpt-image-1, low quality JPEG — ~$0.01/image, returns b64_json (~125KB)
  const resp = await openai.images.generate({
    model: "gpt-image-1",
    prompt: prompt.slice(0, 900),
    n: 1,
    size: "1024x1024",
    quality: "low" as "low",
    // @ts-ignore output_format not yet in SDK types
    output_format: "jpeg",
  });
  // PRODUCTION (replace above):
  // quality: "high", output_format: "jpeg", size: "1792x1024"
  const b64 = resp.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI image generation returned no b64_json");
  return b64;
}

async function generateImages(
  title: string,
  h2Headings: string[],
): Promise<{ heroB64: string; sectionB64s: string[] }> {
  const heroPrompt = `Professional studio photo of high-end makeup brushes and cosmetic tools for article about: ${title.slice(0, 100)}. Elegant product arrangement on neutral background. No text, no words, no letters. Soft studio lighting.`;
  const heroB64 = await generateSingleImage(heroPrompt);

  // Pick 2nd and 4th headings (index 1 and 3) for section images
  const sectionHeadings = [h2Headings[1], h2Headings[3]].filter(Boolean) as string[];
  const sectionB64s: string[] = [];
  for (const heading of sectionHeadings) {
    const sectionPrompt = `Professional macro photo of beauty and makeup products representing: ${heading.slice(0, 120)}. Studio setting, clean neutral background. No text, no words, no letters.`;
    sectionB64s.push(await generateSingleImage(sectionPrompt));
  }

  return { heroB64, sectionB64s };
}

function injectSectionImages(html: string, imageUrls: string[], alts: string[]): string {
  // Insert img tags after the 2nd H2 (h2Count=1) and 4th H2 (h2Count=3)
  let h2Count = -1;
  return html.replace(/<\/h2>/gi, (match) => {
    h2Count++;
    const urlIndex = h2Count === 1 ? 0 : h2Count === 3 ? 1 : -1;
    if (urlIndex >= 0 && imageUrls[urlIndex]) {
      const alt = (alts[urlIndex] ?? "").replace(/"/g, "&quot;");
      return `</h2>\n<img src="${imageUrls[urlIndex]}" alt="${alt}" style="width:100%;border-radius:8px;margin:24px 0" loading="lazy">`;
    }
    return match;
  });
}

function sanitizeHTML(html: string): string {
  return html
    .replace(/<h1[^>]*>[\s\S]*?<\/h1>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<link[^>]*>/gi, "")
    .replace(/application\/ld\+json/gi, "");
}

export async function publishPlanItem(
  admin: { graphql: AdminGraphQL },
  planId: number,
  shop: string,
): Promise<void> {
  const plan = await db.blogContentPlan.findUnique({ where: { id: planId } });
  if (!plan) throw new Error("Plan item not found");
  if (plan.shop !== shop) throw new Error("Not authorized");
  if (plan.status === "published") throw new Error("Already published");

  const settings = await db.blogSettings.findUnique({ where: { shop } });
  if (!settings?.blogId) throw new Error("No blog configured — go to Settings first.");

  try {
    // 1. Keywords
    const keywords = await enrichKeywords(plan.topic, plan.category);

    // 2. Research
    const research = await researchTopic(plan.topic, keywords);

    // 3. Existing articles for internal links
    const existingArticles = await getShopifyArticles(admin, settings.blogId);

    // 4. Article body (HTML)
    const bodyHtml = await generateArticleBody(
      plan.topic,
      plan.category,
      keywords,
      research,
      existingArticles,
      settings,
    );

    // 5. Metadata
    const meta = await generateArticleMetadata(plan.topic, bodyHtml, keywords);

    // 6. Sanitize
    const safeHtml = sanitizeHTML(bodyHtml);

    // 7. Generate images and inject into body (non-blocking — article still publishes on failure)
    let finalBodyHtml = safeHtml;
    let heroImageUrl: string | null = null;
    let sectionAlts: string[] = [];
    try {
      const h2Headings = extractH2Headings(safeHtml);
      sectionAlts = [h2Headings[1] ?? plan.topic, h2Headings[3] ?? plan.topic];

      console.log("[images] Generating images for article:", plan.topic);
      const { heroB64, sectionB64s } = await generateImages(plan.topic, h2Headings);

      heroImageUrl = await uploadImageToShopifyCDN(admin, heroB64, `${plan.topic} — ENCANTO`);
      console.log("[images] Hero uploaded:", heroImageUrl);

      const sectionUrls: string[] = [];
      for (let i = 0; i < sectionB64s.length; i++) {
        const cdnUrl = await uploadImageToShopifyCDN(admin, sectionB64s[i], `${sectionAlts[i]} — ENCANTO`);
        sectionUrls.push(cdnUrl);
        console.log(`[images] Section ${i} uploaded:`, cdnUrl);
      }

      finalBodyHtml = injectSectionImages(safeHtml, sectionUrls, sectionAlts);
    } catch (imgErr) {
      console.error("[images] Failed, continuing without images:", imgErr instanceof Error ? imgErr.message : imgErr);
    }

    // 8. Publish to Shopify
    const displayTitle = (meta.title && meta.title.trim()) || plan.topic;
    const brandName = settings.brandName || "ENCANTO";
    const published = await publishArticleToShopify(admin, settings.blogId, {
      title: displayTitle,
      body_html: finalBodyHtml,
      summary_html: meta.excerpt || "",
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      published: true,
      authorName: brandName,
      seoTitle: buildSeoTitle(displayTitle, brandName),
      metaDescription: truncateMetaDescription(meta.metaDescription || ""),
    });

    // 9. Set hero image on the published article
    if (heroImageUrl) {
      try {
        await setArticleHeroImage(admin, published.id, heroImageUrl, `${displayTitle} — ENCANTO`);
        console.log("[images] Hero image set on article");
      } catch (heroErr) {
        console.error("[images] Failed to set hero image:", heroErr instanceof Error ? heroErr.message : heroErr);
      }
    }

    // Construct storefront URL from blog/article handles
    const articleUrl = `https://${shop}/blogs/${published.blogHandle}/${published.handle}`;

    // 10. Update plan row
    await db.blogContentPlan.update({
      where: { id: planId },
      data: {
        status: "published",
        articleId: published.id,
        articleUrl,
        publishedAt: new Date(),
        keywords,
        errorMessage: null,
      },
    });
  } catch (err) {
    await db.blogContentPlan.update({
      where: { id: planId },
      data: {
        status: "failed",
        errorMessage: err instanceof Error ? err.message : "Unknown error",
      },
    });
    throw err;
  }
}
