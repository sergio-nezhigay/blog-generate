import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import {
  generateWeeklyPlan,
  getWeekStart,
  weekAlreadyPlanned,
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

  const activeShops = await db.blogSettings.findMany({
    where: { active: true, blogId: { not: "" } },
  });

  const results: { shop: string; status: string; error?: string }[] = [];
  const weekStart = getWeekStart(new Date());

  for (const settings of activeShops) {
    try {
      const alreadyPlanned = await weekAlreadyPlanned(settings.shop, weekStart);
      if (alreadyPlanned) {
        results.push({ shop: settings.shop, status: "already-planned" });
        continue;
      }

      const { admin } = await unauthenticated.admin(settings.shop);
      const existingArticles = await getShopifyArticles(admin, settings.blogId);
      const existingTitles = existingArticles.map((a) => a.title);

      await generateWeeklyPlan(settings.shop, settings, existingTitles);
      results.push({ shop: settings.shop, status: "planned" });
    } catch (err) {
      results.push({
        shop: settings.shop,
        status: "error",
        error: err instanceof Error ? err.message : "Unknown",
      });
    }
  }

  return new Response(
    JSON.stringify({ ok: true, weekStart: weekStart.toISOString(), results }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};
