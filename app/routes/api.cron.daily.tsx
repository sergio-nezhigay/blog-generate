import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { getTodaysPlan } from "../services/blog/contentPlanner.server";
import { publishPlanItem } from "../services/blog/articleWriter.server";

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
    select: { shop: true },
  });

  const results: { shop: string; status: string; error?: string }[] = [];
  const today = new Date();

  for (const { shop } of activeShops) {
    try {
      const plan = await getTodaysPlan(shop, today);

      if (!plan) {
        results.push({ shop, status: "no-plan-today" });
        continue;
      }
      if (plan.status === "published") {
        results.push({ shop, status: "already-published" });
        continue;
      }

      const { admin } = await unauthenticated.admin(shop);
      await publishPlanItem(admin, plan.id, shop);
      results.push({ shop, status: "published" });
    } catch (err) {
      results.push({
        shop,
        status: "error",
        error: err instanceof Error ? err.message : "Unknown",
      });
    }
  }

  return new Response(JSON.stringify({ ok: true, date: today.toISOString(), results }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
