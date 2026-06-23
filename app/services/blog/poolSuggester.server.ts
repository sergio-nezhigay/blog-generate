import { chatCompleteJSON } from "./openai.server";
import type { ContentCategory } from "./contentPlanner.server";

const ICP_CONTEXT = `
Brand: ENCANTO — premium professional makeup tools (eyeshadow palettes, brushes, brow products, tweezers, sponges).
Audience: Professional makeup artists, beauty salon owners, aesthetics professionals, beauty school instructors, and serious makeup enthusiasts in Spain, Europe, and the Gulf region.
Tone: Authoritative, professional, practical. Not beginner-focused. Not budget-focused.
ENCANTO sells TOOLS ONLY — brushes, tweezers, sponges, eyeshadow palettes.
`.trim();

export async function suggestQAQuestions(
  categoryName: string,
  currentPool: string[],
  brandName: string,
): Promise<string[]> {
  const productName = categoryName.replace("qa-", "").replace(/-/g, " ");

  const result = await chatCompleteJSON<{ questions: string[] }>(
    [
      {
        role: "system",
        content: `You are a content strategist for ${brandName}, a premium professional makeup tools brand.\n${ICP_CONTEXT}`,
      },
      {
        role: "user",
        content: `Suggest 10 NEW customer questions about "${productName}" that a professional MUA would realistically search for.

These questions will become SEO blog article topics, so they should reflect genuine purchase doubts, professional usage concerns, or technical performance questions.

DO NOT repeat or closely paraphrase any question from this list:
${currentPool.map((q, i) => `${i + 1}. ${q}`).join("\n")}

Requirements for each question:
- Practical and specific (not vague like "Is it good?")
- Relevant to professional makeup artists, not beginners
- About the tool's performance, texture, durability, technique, or comparison
- Written in plain English as a real question

Respond with JSON: { "questions": ["Q1", "Q2", ..., "Q10"] }`,
      },
    ],
    { temperature: 0.85, maxTokens: 600 },
  );

  const questions = result.questions;
  if (!Array.isArray(questions)) return [];
  return questions
    .map((q) => String(q).trim())
    .filter((q) => q.length > 10 && !currentPool.includes(q));
}

export async function suggestFashionCategory(
  existingCategories: ContentCategory[],
  brandName: string,
): Promise<{ name: string; format: string; titlePattern: string; targetWordCount: number }> {
  const existingList = existingCategories
    .map((c) => `- ${c.name} (${c.format}): "${c.titlePattern}"`)
    .join("\n");

  const result = await chatCompleteJSON<{
    name: string;
    format: string;
    titlePattern: string;
    targetWordCount: number;
  }>(
    [
      {
        role: "system",
        content: `You are a content strategist for ${brandName}, a premium professional makeup tools brand.\n${ICP_CONTEXT}`,
      },
      {
        role: "user",
        content: `Propose ONE new blog content category for a professional makeup tools brand.

Existing categories (do NOT duplicate):
${existingList}

The new category should:
- Be clearly distinct from the existing ones
- Serve professional MUAs (not beginners or budget shoppers)
- Have a title pattern that naturally generates many unique articles over time
- Fit one of these formats: listicle | comparison | evergreen-guide | technical | qa-deepdive

Return JSON:
{
  "name": "kebab-case-slug",
  "format": "one of the formats above",
  "titlePattern": "Title Template With [Placeholder] Variables",
  "targetWordCount": 2000
}`,
      },
    ],
    { temperature: 0.85, maxTokens: 300 },
  );

  return {
    name: String(result.name ?? "new-category").toLowerCase().replace(/\s+/g, "-"),
    format: String(result.format ?? "evergreen-guide"),
    titlePattern: String(result.titlePattern ?? "[Topic]: Pro MUA Guide"),
    targetWordCount: Number(result.targetWordCount ?? 2000),
  };
}
