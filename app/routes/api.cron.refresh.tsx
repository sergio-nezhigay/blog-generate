import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { refreshStaleArticles } from "../services/blog/articleRefresher.server";

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
    select: { shop: true, blogId: true },
  });

  const results: { shop: string; status: string; refreshed?: number; error?: string }[] = [];

  for (const { shop, blogId } of activeShops) {
    try {
      const { admin } = await unauthenticated.admin(shop);
      const refreshResults = await refreshStaleArticles(admin, blogId, shop);
      const updated = refreshResults.filter((r) => r.status === "updated").length;
      results.push({ shop, status: "ok", refreshed: updated });
    } catch (err) {
      results.push({
        shop,
        status: "error",
        error: err instanceof Error ? err.message : "Unknown",
      });
    }
  }

  return new Response(
    JSON.stringify({ ok: true, date: new Date().toISOString(), results }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};
