import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import {
  generateWeeklyPlan,
  getWeekStart,
  getWeekType,
  weekAlreadyPlanned,
  type WeekType,
} from "../services/blog/contentPlanner.server";
import { getShopifyArticles } from "../services/blog/shopifyBlog.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const secret = request.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const url = new URL(request.url);
  const weekTypeParam = url.searchParams.get("weekType");
  const weekTypeOverride: WeekType | undefined =
    weekTypeParam === "fashion" || weekTypeParam === "qa" ? weekTypeParam : undefined;
  const preview = url.searchParams.get("preview") === "true";

  const activeShops = await db.blogSettings.findMany({
    where: { active: true, blogId: { not: "" } },
  });

  const results: Record<string, unknown>[] = [];
  const weekStart = getWeekStart(new Date());
  const autoWeekType = getWeekType(weekStart);

  for (const settings of activeShops) {
    try {
      if (!preview) {
        const alreadyPlanned = await weekAlreadyPlanned(settings.shop, weekStart);
        if (alreadyPlanned) {
          results.push({ shop: settings.shop, status: "already-planned" });
          continue;
        }
      }

      const { admin } = await unauthenticated.admin(settings.shop);
      const existingArticles = await getShopifyArticles(admin, settings.blogId);
      const existingTitles = existingArticles.map((a) => a.title);

      const result = await generateWeeklyPlan(settings.shop, settings, existingTitles, {
        weekTypeOverride,
        dryRun: preview,
      });

      results.push({
        shop: settings.shop,
        status: preview ? "preview" : "planned",
        weekType: result.weekType,
        topics: result.topics.map((t) => ({
          day: t.dayIndex,
          category: t.category,
          topic: t.topic,
          targetWordCount: t.targetWordCount,
        })),
      });
    } catch (err) {
      results.push({
        shop: settings.shop,
        status: "error",
        error: err instanceof Error ? err.message : "Unknown",
      });
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      weekStart: weekStart.toISOString(),
      autoWeekType,
      weekTypeOverride: weekTypeOverride ?? null,
      preview,
      results,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};
