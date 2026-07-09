import OpenAI from "openai";

let client: OpenAI | null = null;

function getPerplexity(): OpenAI {
  if (!client) {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey) throw new Error("PERPLEXITY_API_KEY is not set");
    client = new OpenAI({ apiKey, baseURL: "https://api.perplexity.ai" });
  }
  return client;
}

export async function sonarComplete(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  const perplexity = getPerplexity();
  const res = await perplexity.chat.completions.create({
    model: "sonar",
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 600,
  });
  const content = res.choices[0]?.message?.content ?? "";
  console.log(`[perplexity] sonar call ok, ${content.length} chars returned`);
  return content;
}
