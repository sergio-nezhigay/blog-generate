import db from "../../db.server";
import { getShopifyArticles, getArticleBody, updateArticleContent } from "./shopifyBlog.server";
import { chatComplete } from "./openai.server";

type AdminGraphQL = (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;

export interface RefreshResult {
  articleId: string;
  oldTitle: string;
  newTitle?: string;
  status: "updated" | "skipped" | "error";
  error?: string;
}

export function detectStaleYear(title: string, currentYear: number): number | null {
  const match = title.match(/\b(202\d)\b/);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  return year < currentYear ? year : null;
}

export async function refreshStaleArticles(
  admin: { graphql: AdminGraphQL },
  blogId: string,
  shop: string,
): Promise<RefreshResult[]> {
  const currentYear = new Date().getFullYear();
  const results: RefreshResult[] = [];

  const { articles } = await getShopifyArticles(admin, blogId);

  const plans = await db.blogContentPlan.findMany({
    where: { shop, articleId: { not: null }, status: "published" },
    select: { articleId: true },
  });
  const appArticleIds = new Set(plans.map((p) => p.articleId!));

  for (const article of articles) {
    if (!appArticleIds.has(article.id)) continue;

    const staleYear = detectStaleYear(article.title, currentYear);
    if (!staleYear) {
      results.push({ articleId: article.id, oldTitle: article.title, status: "skipped" });
      continue;
    }

    try {
      const { bodyHtml } = await getArticleBody(admin, article.id);
      const newBody = await refreshBodyHtml(bodyHtml, staleYear, currentYear);
      const newTitle = article.title.replace(new RegExp(`\\b${staleYear}\\b`, "g"), String(currentYear));

      await updateArticleContent(admin, article.id, newTitle, newBody);
      console.log(`[refresher] Updated: "${article.title}" → "${newTitle}"`);
      results.push({ articleId: article.id, oldTitle: article.title, newTitle, status: "updated" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`[refresher] Error on ${article.id}: ${msg}`);
      results.push({ articleId: article.id, oldTitle: article.title, status: "error", error: msg });
    }
  }

  return results;
}

async function refreshBodyHtml(bodyHtml: string, staleYear: number, currentYear: number): Promise<string> {
  const updated = await chatComplete([
    {
      role: "system",
      content: `You are an SEO content editor. You will receive an HTML article body.
Find every sentence that contains the year ${staleYear} and rewrite ONLY those sentences, replacing ${staleYear} with ${currentYear} and updating any relative time phrases ("last year", "this year", "in recent years") to match.
Return the COMPLETE HTML with ALL other content, tags, attributes, links, and structure exactly unchanged.
Do NOT add, remove, or alter any HTML tags, class names, IDs, href values, or non-year content.
Do NOT wrap the output in markdown code fences.`,
    },
    {
      role: "user",
      content: bodyHtml,
    },
  ], { temperature: 0.3, maxTokens: 6000 });
  return updated.trim();
}
