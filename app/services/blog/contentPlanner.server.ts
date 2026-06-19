import db from "../../db.server";
import { chatCompleteJSON } from "./openai.server";
import { isDuplicate } from "./deduplication.server";
import type { BlogSettings } from "@prisma/client";

export interface ContentCategory {
  dayIndex: number; // 0=Mon … 6=Sun
  name: string;
  format: string;
  titlePattern: string;
}

export const CONTENT_CATEGORIES: ContentCategory[] = [
  {
    dayIndex: 0,
    name: "must-have-tools",
    format: "listicle",
    titlePattern: "X Best [Tool/Product] for [Professional Technique] in 2026",
  },
  {
    dayIndex: 1,
    name: "tool-comparison",
    format: "comparison",
    titlePattern:
      "[Tool A] vs [Tool B]: Which Is Better for Professional Makeup Artists?",
  },
  {
    dayIndex: 2,
    name: "technique-guide",
    format: "technique-guide",
    titlePattern: "How to [Apply/Create] [Look or Technique] Step-by-Step",
  },
  {
    dayIndex: 3,
    name: "product-guide",
    format: "product-guide",
    titlePattern:
      "Complete Guide to [Product Category]: What Professional MUAs Use in 2026",
  },
  {
    dayIndex: 4,
    name: "pro-tips",
    format: "pro-tips",
    titlePattern:
      "X Professional Makeup Artist Tips for [Skill or Situation] in 2026",
  },
  {
    dayIndex: 5,
    name: "trend",
    format: "trend",
    titlePattern:
      "[Season/Year] Makeup Trends: Colors, Techniques, and Tools to Know",
  },
  {
    dayIndex: 6,
    name: "tool-care",
    format: "tool-care",
    titlePattern:
      "How to Clean and Maintain Your [Tool Type]: A Professional Guide",
  },
];

const ICP_FILTER = `
TARGET AUDIENCE: Professional makeup artists (MUAs), beauty salon owners,
aesthetics professionals, beauty school instructors, and serious makeup
enthusiasts in Spain, Europe, and the Gulf region who invest in premium
professional-grade makeup tools.

PRODUCT NICHE: ENCANTO brand — premium professional makeup tools including
eyeshadow palettes, face and eye brushes, brow products, tweezers, and sponges.

REJECT these topics: beginner "how to start wearing makeup" tutorials,
drugstore or budget product recommendations, general lifestyle content
unrelated to professional makeup tools.

FOCUS ON: Professional techniques, tool quality, brush care, editorial looks,
competition with high-end tool brands, product comparisons relevant to working MUAs.
`.trim();

// Get the Monday of the week containing `date`.
export function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getUTCDay(); // 0=Sun, 1=Mon…
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// Returns the scheduled date for a given weekStart + dayIndex (0=Mon…6=Sun).
function scheduledDate(weekStart: Date, dayIndex: number): Date {
  const d = new Date(weekStart);
  d.setUTCDate(d.getUTCDate() + dayIndex);
  return d;
}

export async function weekAlreadyPlanned(
  shop: string,
  weekStart: Date,
): Promise<boolean> {
  const count = await db.blogContentPlan.count({
    where: { shop, weekStart },
  });
  return count > 0;
}

export async function getTodaysPlan(shop: string, today: Date) {
  const start = new Date(today);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  return db.blogContentPlan.findFirst({
    where: {
      shop,
      scheduledDate: { gte: start, lt: end },
      status: "planned",
    },
  });
}

export async function generateWeeklyPlan(
  shop: string,
  settings: BlogSettings,
  existingTitles: string[],
): Promise<void> {
  const weekStart = getWeekStart(new Date());

  if (await weekAlreadyPlanned(shop, weekStart)) {
    return; // idempotent
  }

  const rows: {
    shop: string;
    weekStart: Date;
    dayIndex: number;
    scheduledDate: Date;
    topic: string;
    category: string;
    contentFormat: string;
    targetWordCount: number;
    keywords: string[];
    status: string;
  }[] = [];

  for (const cat of CONTENT_CATEGORIES) {
    const topic = await generateTopicForCategory(
      cat,
      settings.brandName,
      existingTitles.concat(rows.map((r) => r.topic)),
    );

    rows.push({
      shop,
      weekStart,
      dayIndex: cat.dayIndex,
      scheduledDate: scheduledDate(weekStart, cat.dayIndex),
      topic,
      category: cat.name,
      contentFormat: cat.format,
      targetWordCount: 2000,
      keywords: [],
      status: "planned",
    });
  }

  await db.blogContentPlan.createMany({ data: rows });
}

async function generateTopicForCategory(
  cat: ContentCategory,
  brandName: string,
  usedTitles: string[],
  attempt = 0,
): Promise<string> {
  if (attempt > 3) {
    // Fallback: return a safe generic title using the pattern
    return cat.titlePattern
      .replace("[Tool/Product]", "Makeup Brushes")
      .replace("[Professional Technique]", "Professionals");
  }

  const result = await chatCompleteJSON<{ topic: string }>(
    [
      {
        role: "system",
        content: `You are a content strategist for ${brandName}, a premium professional makeup tools brand. ${ICP_FILTER}`,
      },
      {
        role: "user",
        content: `Generate ONE compelling blog article title for the following content category.

Category: ${cat.name}
Format: ${cat.format}
Title pattern to follow: ${cat.titlePattern}

Requirements:
- The title must be 50–70 characters
- It must be specific, not generic (name the actual tool, technique, or product category)
- It must be relevant to professional makeup artists using premium tools
- It must target 2026 and current beauty trends
- Do NOT use any of these already-planned titles: ${usedTitles.slice(0, 20).join(" | ")}

Respond with JSON: { "topic": "Your Article Title Here" }`,
      },
    ],
    { temperature: 0.8, maxTokens: 200 },
  );

  const topic = result.topic?.trim() ?? "";

  if (!topic || isDuplicate(topic, usedTitles)) {
    return generateTopicForCategory(cat, brandName, usedTitles, attempt + 1);
  }

  return topic;
}
