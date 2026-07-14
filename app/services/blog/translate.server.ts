import type { ArticleTranslation } from "@prisma/client";
import db from "../../db.server";
import { chatCompleteJSON } from "./openai.server";
import { getTranslatableContent, registerTranslations } from "./shopifyBlog.server";

type AdminGraphQL = (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;

interface TranslatedFields {
  title: string;
  bodyHtml: string;
  summaryHtml: string;
  metaTitle: string;
  metaDescription: string;
}

const TRANSLATE_SYSTEM_PROMPT = `You are a professional translator for ENCANTO, a professional makeup tools brand.
Translate the given article fields into {LANG}. Rules:
- Preserve ALL HTML tags, attributes, "id" values, "class" values, and "href" values EXACTLY as-is — do not translate or alter them.
- Only translate visible text content (inside <p>, <h2>, <h3>, <summary>, <a> link text, <strong>, <li>, alt text in <img>).
- Do not translate anchor "id" slugs (e.g. id="introduction" stays "introduction") since internal links depend on them.
- Keep the same HTML structure, tag nesting, and whitespace-sensitive elements (<details>/<summary>) intact.
- Return strict JSON: {"title": string, "bodyHtml": string, "summaryHtml": string, "metaTitle": string, "metaDescription": string}. No commentary, no markdown fences.`;

export async function translateArticleFields(
  fields: { title: string; bodyHtml: string; summaryHtml: string; metaTitle: string; metaDescription: string },
  locale: string,
  langName: string,
): Promise<TranslatedFields> {
  return chatCompleteJSON<TranslatedFields>([
    { role: "system", content: TRANSLATE_SYSTEM_PROMPT.replace("{LANG}", langName) },
    {
      role: "user",
      content: `Title: ${fields.title}\n\nSummary HTML: ${fields.summaryHtml}\n\nMeta title: ${fields.metaTitle}\n\nMeta description: ${fields.metaDescription}\n\nBody HTML:\n${fields.bodyHtml}`,
    },
  ], { model: "gpt-4o-mini", temperature: 0.3, maxTokens: 16000 });
}

// Shopify locale codes only carry an ISO 639-1 code here; a fuller name map keeps GPT-4o-mini's
// target-language instruction unambiguous (e.g. "no" -> "Norwegian", not the literal string "no").
const LOCALE_NAMES: Record<string, string> = {
  ar: "Arabic", cs: "Czech", da: "Danish", de: "German", el: "Greek", es: "Spanish",
  fi: "Finnish", fr: "French", hu: "Hungarian", it: "Italian", nl: "Dutch", no: "Norwegian",
  pl: "Polish", ro: "Romanian", ru: "Russian", sk: "Slovak", sv: "Swedish", tr: "Turkish", uk: "Ukrainian",
};

export async function enqueueTranslations(planId: number, shop: string): Promise<void> {
  const [plan, settings] = await Promise.all([
    db.blogContentPlan.findUnique({ where: { id: planId } }),
    db.blogSettings.findUnique({ where: { shop } }),
  ]);
  if (!plan || plan.status !== "published") return;
  if (!settings?.translationEnabled || settings.translationLocales.length === 0) return;

  // Republishing (resetToPlan -> Generate again) reuses the same planId with a new
  // Shopify articleId — drop any translations queued/done against the prior article
  // so they don't collide with skipDuplicates and leave stale "done" rows behind.
  await db.articleTranslation.deleteMany({ where: { planId } });
  await db.articleTranslation.createMany({
    data: settings.translationLocales.map((locale) => ({ planId, shop, locale })),
  });
}

export async function translateQueuedItem(
  admin: { graphql: AdminGraphQL },
  row: ArticleTranslation,
): Promise<void> {
  await db.articleTranslation.update({ where: { id: row.id }, data: { status: "translating" } });

  try {
    const plan = await db.blogContentPlan.findUnique({ where: { id: row.planId } });
    if (!plan?.articleId) throw new Error("Plan has no articleId");

    const translatableContent = await getTranslatableContent(admin, plan.articleId);

    const byKey = new Map(translatableContent.map((c) => [c.key, c]));
    const title = byKey.get("title");
    const bodyContent = byKey.get("body_html");
    const summary = byKey.get("summary_html");
    const metaTitle = byKey.get("meta_title");
    const metaDescription = byKey.get("meta_description");
    if (!title || !bodyContent) throw new Error("translatableResource returned no title/body_html content");

    const langName = LOCALE_NAMES[row.locale] ?? row.locale;
    const translated = await translateArticleFields({
      title: title.value,
      bodyHtml: bodyContent.value,
      summaryHtml: summary?.value ?? "",
      metaTitle: metaTitle?.value ?? "",
      metaDescription: metaDescription?.value ?? "",
    }, row.locale, langName);

    const translations: { key: string; value: string; translatableContentDigest: string }[] = [
      { key: "title", value: translated.title, translatableContentDigest: title.digest },
      { key: "body_html", value: translated.bodyHtml, translatableContentDigest: bodyContent.digest },
    ];
    if (summary) translations.push({ key: "summary_html", value: translated.summaryHtml, translatableContentDigest: summary.digest });
    if (metaTitle) translations.push({ key: "meta_title", value: translated.metaTitle, translatableContentDigest: metaTitle.digest });
    if (metaDescription) translations.push({ key: "meta_description", value: translated.metaDescription, translatableContentDigest: metaDescription.digest });

    await registerTranslations(admin, plan.articleId, row.locale, translations);

    await db.articleTranslation.update({
      where: { id: row.id },
      data: { status: "done", translatedAt: new Date(), errorMessage: null },
    });
  } catch (err) {
    await db.articleTranslation.update({
      where: { id: row.id },
      data: {
        status: "failed",
        attempts: { increment: 1 },
        errorMessage: err instanceof Error ? err.message : "Unknown error",
      },
    });
    throw err;
  }
}
