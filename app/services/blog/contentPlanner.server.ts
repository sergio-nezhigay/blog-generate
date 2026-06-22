import db from "../../db.server";
import { chatCompleteJSON } from "./openai.server";
import { isDuplicate } from "./deduplication.server";
import type { BlogSettings } from "@prisma/client";

export type WeekType = "fashion" | "qa";

export interface ContentCategory {
  dayIndex: number;
  name: string;
  format: string;
  titlePattern: string;
  weekType: WeekType;
  targetWordCount: number;
  questionPool?: string[];
}

// Odd ISO weeks (1, 3, 5 …) — makeup tool lifestyle & trends content
export const FASHION_CATEGORIES: ContentCategory[] = [
  {
    dayIndex: 0,
    name: "seasonal-trends",
    format: "listicle",
    titlePattern: "Top X Professional Makeup Tool Trends for [Month Year]",
    weekType: "fashion",
    targetWordCount: 2200,
  },
  {
    dayIndex: 1,
    name: "brand-comparison",
    format: "comparison",
    titlePattern: "[Brand A] vs [Brand B] Professional Brushes: Which Is Worth It?",
    weekType: "fashion",
    targetWordCount: 2000,
  },
  {
    dayIndex: 2,
    name: "look-guide",
    format: "listicle",
    titlePattern: "The Complete Makeup Kit for [Occasion]: Tools & Techniques",
    weekType: "fashion",
    targetWordCount: 2200,
  },
  {
    dayIndex: 3,
    name: "care-and-technique",
    format: "evergreen-guide",
    titlePattern: "How to [Professional Technique or Care Topic]: Pro MUA Guide",
    weekType: "fashion",
    targetWordCount: 2000,
  },
  {
    dayIndex: 4,
    name: "shopping-picks",
    format: "listicle",
    titlePattern: "Must-Have Professional Makeup Tools for [Month Year]",
    weekType: "fashion",
    targetWordCount: 2200,
  },
  {
    dayIndex: 5,
    name: "tool-comparison",
    format: "comparison",
    titlePattern: "[Tool A] vs [Tool B]: What Pro MUAs Actually Choose",
    weekType: "fashion",
    targetWordCount: 2000,
  },
  {
    dayIndex: 6,
    name: "makeup-how-to",
    format: "technical",
    titlePattern: "How to [Specific Makeup Technique]: Step-by-Step for MUAs",
    weekType: "fashion",
    targetWordCount: 1800,
  },
];

// Even ISO weeks (2, 4, 6 …) — one deep-dive per product type answering real customer questions
export const QA_CATEGORIES: ContentCategory[] = [
  {
    dayIndex: 0,
    name: "qa-eyeshadow",
    format: "qa-deepdive",
    titlePattern: "[Customer question about eyeshadows] — Pro Answer",
    weekType: "qa",
    targetWordCount: 2000,
    questionPool: [
      "Do eyeshadows dust when picked up with a brush?",
      "Do eyeshadows need a base to match the pan colour?",
      "Do eyeshadows crease in the eyelid fold after 4–6 hours?",
      "How many grams does one eyeshadow refill weigh?",
      "Are the eyeshadow pans refillable?",
      "How does ENCANTO eyeshadow texture compare to Viseart?",
      "Which brush type should you use for eyeshadow application?",
      "Which hair type is best for blending eyeshadows?",
      "What is the country of origin of ENCANTO eyeshadows?",
      "What is the shelf life of professional eyeshadows?",
      "Do eyeshadow palettes contain shimmers in every pan?",
      "Are ENCANTO eyeshadows tested on animals?",
      "Does the pan colour match what you see on the skin?",
      "Do eyeshadows tint the eyelid permanently?",
      "Do eyeshadows fall out under the eyes during wear?",
      "Do dark eyeshadow shades patch when applied?",
      "Do matte eyeshadows leave spots or streaks?",
      "Are shimmer eyeshadows oily or dry in texture?",
      "Do glitter shades fall under the eyes during wear?",
      "Are the palettes suitable for both day and evening makeup?",
      "Is the gold shade in ENCANTO palettes too warm or yellow?",
      "Does blue eyeshadow turn muddy when blended with brown?",
      "Can eyeshadow palettes be used for facial sculpting?",
      "How durable is the palette lid — will it snap with daily use?",
      "Are ENCANTO palettes fragile or robust enough for kit use?",
      "Do eyeshadow palettes survive shipping without damage?",
      "Are ENCANTO eyeshadows suitable for beginners or only pros?",
      "Which palette works best for fair, neutral, and deep skin tones?",
      "Is the pigment visible from the very first touch?",
    ],
  },
  {
    dayIndex: 1,
    name: "qa-powder",
    format: "qa-deepdive",
    titlePattern: "[Customer question about face powder] — Pro Answer",
    weekType: "qa",
    targetWordCount: 2000,
    questionPool: [
      "Does pressed powder emphasize dry patches and flaky skin?",
      "Is powder visible in macro or high-resolution photography?",
      "Does face powder oxidize and change colour during the day?",
      "Does highlighter give big glitter particles or a delicate glow?",
      "Does powder blend smoothly without patches or hard lines?",
      "Are ENCANTO powder products tested on animals?",
      "Is the powder compact closure reliable for professional kit use?",
      "Is the formula baked or traditionally pressed?",
      "Is the grind fine or coarse — how does it feel on skin?",
      "Is there a dedicated finishing or setting powder in the range?",
      "Does the highlighter leave grey streaks on deeper skin tones?",
      "Is the powder suitable for very fair or light skin tones?",
      "Is it suitable for photography and professional studio work?",
      "Can you mix different powder shades to create custom tones?",
      "Does the compact have a 180-degree opening lid?",
      "Does the compact close with a magnetic lock?",
      "Does the compact case show fingerprints or get dirty easily?",
      "Does powder emphasize skin texture, large pores, or fine lines?",
      "Can it create a retouched or airbrushed photoshop-style effect?",
    ],
  },
  {
    dayIndex: 2,
    name: "qa-brushes",
    format: "qa-deepdive",
    titlePattern: "[Customer question about makeup brushes] — Pro Answer",
    weekType: "qa",
    targetWordCount: 2000,
    questionPool: [
      "What wood are CTR professional brush handles made from?",
      "Do CTR brush hairs shed during application or washing?",
      "Are CTR brush bristles hand-set or machine-cut?",
      "How should professional makeup brushes be cared for?",
      "What is the correct technique for washing professional brushes?",
      "Why does CTR brush hair have a visible shine?",
      "Which CTR brushes are suitable for cream textures?",
      "Which CTR brush is best for blending eyeshadow?",
      "Which bristle type gives the best eyeshadow application?",
      "Which bristle type gives the best eyeshadow diffusion and blending?",
      "Is it normal for hairs to fall out on the first wash?",
      "Are CTR brushes densely packed or soft and airy?",
      "Will CTR brushes scratch the delicate skin around the eyes?",
      "Can CTR brush bristles cause an allergic reaction?",
      "How thin and sharp is the edge on a CTR angled brush?",
      "Can CTR brushes create realistic hair-stroke brow techniques?",
      "Will CTR bristles fray after contact with brow dyes or henna?",
      "Does shiny bristle mean the brush is natural hair or synthetic?",
      "How soft is CTR bristle — what are the softness levels?",
      "What is a fan or torch-shaped brush best used for?",
      "Is a duofiber brush suitable for dense full-coverage foundation?",
      "Does a CTR foundation brush pack product densely onto skin?",
      "Does a CTR foundation brush leave streaks on the skin?",
      "Which CTR brush works best for the pencil eyeshadow technique?",
      "Which CTR brushes give the best crease and orbital line work?",
      "Does handle lacquer peel off after using salon cleansers?",
    ],
  },
  {
    dayIndex: 3,
    name: "qa-lashes",
    format: "qa-deepdive",
    titlePattern: "[Customer question about false lashes] — Pro Answer",
    weekType: "qa",
    targetWordCount: 2000,
    questionPool: [
      "Is the knot on false lashes visible when wearing them?",
      "How thin is the lash fiber — does it look natural?",
      "Is it easy to remove false lashes from their packaging tray?",
      "C curl or D curl — which is better for hooded or almond eyes?",
      "Is 12D lash density sparse, or is 20D needed for a full look?",
    ],
  },
  {
    dayIndex: 4,
    name: "qa-brow-gel",
    format: "qa-deepdive",
    titlePattern: "[Customer question about brow fixing gel] — Pro Answer",
    weekType: "qa",
    targetWordCount: 2000,
    questionPool: [
      "Does brow fixing gel leave a white residue on brow hairs?",
      "Can brow gel handle thick, coarse, or unruly brow hairs?",
      "How long does brow gel take to dry completely?",
      "Do brows feel sticky or stiff after brow gel sets?",
      "How long does the hold last throughout the day?",
      "Does brow gel contain nourishing or conditioning ingredients?",
      "How long can brow gel be used after opening the tube?",
      "What is the correct technique for applying brow gel?",
      "Does brow fixing gel dry out the skin under the brows?",
    ],
  },
  {
    dayIndex: 5,
    name: "qa-tweezers",
    format: "qa-deepdive",
    titlePattern: "[Customer question about professional tweezers] — Pro Answer",
    weekType: "qa",
    targetWordCount: 2000,
    questionPool: [
      "Are CTR tweezers sharp enough to grab very fine or short hairs?",
      "Can CTR tweezers grip tiny short hair stubs close to the skin?",
      "How is the tension on CTR tweezers — too tight or too loose?",
      "How well do CTR tweezers handle stiff or coarse hairs?",
      "Does the polished finish on tweezers reflect light into the eyes?",
      "What grade of steel is used in CTR professional tweezers?",
      "Is the squeezing action soft and controlled or does it require force?",
      "Which CTR model is the classic everyday precision tweezer?",
      "Which CTR tweezers have the sharpest, most precise tip?",
      "Are CTR tweezers hand-sharpened or machine-sharpened?",
    ],
  },
  {
    dayIndex: 6,
    name: "qa-brush-wipes",
    format: "qa-deepdive",
    titlePattern: "[Customer question about brush cleaning wipes] — Pro Answer",
    weekType: "qa",
    targetWordCount: 2000,
    questionPool: [
      "Why do brush cleaning wipes leave brushes feeling greasy?",
      "How long does it take for brushes to dry after using wipes?",
      "How many brushes can be cleaned with a single wipe?",
      "Do you need water when using brush cleaning wipes?",
      "How quickly does brush hair dry after express wiping?",
      "Can brush wipes damage the glue bond inside the ferrule?",
      "Do CTR brush wipes contain alcohol?",
      "Are brush wipes safe for both natural hair and synthetic bristles?",
      "What product textures can brush wipes remove — powder only or also cream?",
    ],
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

function getISOWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

export function getWeekType(weekStart: Date): WeekType {
  // Odd ISO week → Fashion/Lifestyle; Even ISO week → Product Q&A
  return getISOWeekNumber(weekStart) % 2 === 1 ? "fashion" : "qa";
}

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
      status: { in: ["planned", "failed"] },
    },
  });
}

export interface PlanTopic {
  topic: string;
  category: string;
  dayIndex: number;
  scheduledDate: Date;
  targetWordCount: number;
}

export interface PlanResult {
  weekType: WeekType;
  topics: PlanTopic[];
}

export async function generateWeeklyPlan(
  shop: string,
  settings: BlogSettings,
  existingTitles: string[],
  options?: { weekTypeOverride?: WeekType; dryRun?: boolean },
): Promise<PlanResult> {
  const weekStart = getWeekStart(new Date());
  const weekType = options?.weekTypeOverride ?? getWeekType(weekStart);
  const categories = weekType === "fashion" ? FASHION_CATEGORIES : QA_CATEGORIES;

  if (!options?.dryRun && (await weekAlreadyPlanned(shop, weekStart))) {
    return { weekType, topics: [] };
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

  const topics: PlanTopic[] = [];

  for (const cat of categories) {
    const topic = await generateTopicForCategory(
      cat,
      settings.brandName,
      existingTitles.concat(rows.map((r) => r.topic)),
    );

    const sd = scheduledDate(weekStart, cat.dayIndex);

    rows.push({
      shop,
      weekStart,
      dayIndex: cat.dayIndex,
      scheduledDate: sd,
      topic,
      category: cat.name,
      contentFormat: cat.format,
      targetWordCount: cat.targetWordCount,
      keywords: [],
      status: "planned",
    });

    topics.push({ topic, category: cat.name, dayIndex: cat.dayIndex, scheduledDate: sd, targetWordCount: cat.targetWordCount });
  }

  if (!options?.dryRun) {
    await db.blogContentPlan.createMany({ data: rows });
  }

  return { weekType, topics };
}

async function generateTopicForCategory(
  cat: ContentCategory,
  brandName: string,
  usedTitles: string[],
  attempt = 0,
): Promise<string> {
  if (attempt > 3) {
    if (cat.questionPool) {
      const unused = cat.questionPool.find((q) => !isDuplicate(q, usedTitles));
      return unused ?? cat.questionPool[0];
    }
    const fallbacks: Record<string, string> = {
      "seasonal-trends": "Top Professional Makeup Tool Trends for Summer 2026",
      "brand-comparison": "ENCANTO vs Sigma Brushes: Which Is Worth It in 2026?",
      "look-guide": "The Complete Bridal Makeup Kit: Tools & Techniques",
      "care-and-technique": "How to Deep-Clean Makeup Brushes: Pro MUA Guide",
      "shopping-picks": "Must-Have Professional Makeup Tools for July 2026",
      "tool-comparison": "Goat vs Synthetic Brushes: What Pro MUAs Actually Choose",
      "makeup-how-to": "How to Blend Eyeshadows Seamlessly: Step-by-Step for MUAs",
    };
    return fallbacks[cat.name] ?? cat.titlePattern;
  }

  if (cat.questionPool) {
    return generateQATopic(cat, brandName, usedTitles, attempt);
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

  // Retry if AI returned an unfilled placeholder pattern or a duplicate
  if (!topic || topic.includes("[") || isDuplicate(topic, usedTitles)) {
    return generateTopicForCategory(cat, brandName, usedTitles, attempt + 1);
  }

  return topic;
}

async function generateQATopic(
  cat: ContentCategory,
  brandName: string,
  usedTitles: string[],
  attempt = 0,
): Promise<string> {
  const available = cat.questionPool!.filter((q) => !isDuplicate(q, usedTitles));

  if (available.length === 0) {
    return `${cat.questionPool![0]} — ${brandName} Professional Guide`;
  }

  const productName = cat.name.replace("qa-", "").replace("-", " ");

  const result = await chatCompleteJSON<{ topic: string }>(
    [
      {
        role: "system",
        content: `You are an SEO content strategist for ${brandName}, a premium professional makeup tools brand.`,
      },
      {
        role: "user",
        content: `Pick ONE question from the list below and rewrite it as a compelling SEO blog article title.

PRODUCT CATEGORY: ${productName}
BRAND: ${brandName}

AVAILABLE QUESTIONS (pick exactly one):
${available.slice(0, 20).map((q, i) => `${i + 1}. ${q}`).join("\n")}

ALREADY COVERED TOPICS (do NOT repeat or closely paraphrase these):
${usedTitles.slice(0, 20).join(" | ")}

Title requirements:
- 50–70 characters
- Reads as a natural question a professional MUA would search for
- Do NOT include the brand name in the title
- Do NOT add meta-phrases like "answered in depth" or "complete guide" unless they fit naturally

Respond with JSON: { "topic": "Article Title Here" }`,
      },
    ],
    { temperature: 0.6, maxTokens: 200 },
  );

  const topic = result.topic?.trim() ?? "";

  if (!topic || isDuplicate(topic, usedTitles)) {
    return generateQATopic(cat, brandName, usedTitles, attempt + 1);
  }

  return topic;
}
