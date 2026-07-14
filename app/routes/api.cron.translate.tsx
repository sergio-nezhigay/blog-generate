import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { translateQueuedItem } from "../services/blog/translate.server";

const MAX_ITEMS_PER_SHOP_PER_TICK = 3;
const MAX_ATTEMPTS = 3;
const STUCK_TRANSLATING_MINUTES = 15;

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const secret = request.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const activeShops = await db.blogSettings.findMany({
    where: { translationEnabled: true },
    select: { shop: true },
  });

  const results: { shop: string; locale: string; status: string; error?: string }[] = [];

  const stuckSince = new Date(Date.now() - STUCK_TRANSLATING_MINUTES * 60 * 1000);

  for (const { shop } of activeShops) {
    const pending = await db.articleTranslation.findMany({
      where: {
        shop,
        OR: [
          { status: "pending" },
          { status: "failed", attempts: { lt: MAX_ATTEMPTS } },
          { status: "translating", updatedAt: { lt: stuckSince } },
        ],
      },
      take: MAX_ITEMS_PER_SHOP_PER_TICK,
      orderBy: { createdAt: "asc" },
    });

    if (pending.length === 0) continue;

    const { admin } = await unauthenticated.admin(shop);
    for (const row of pending) {
      try {
        await translateQueuedItem(admin, row);
        results.push({ shop, locale: row.locale, status: "done" });
      } catch (err) {
        results.push({
          shop,
          locale: row.locale,
          status: "error",
          error: err instanceof Error ? err.message : "Unknown",
        });
      }
    }
  }

  return new Response(JSON.stringify({ ok: true, results }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
