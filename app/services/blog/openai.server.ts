import OpenAI from "openai";

let client: OpenAI | null = null;

export function getOpenAI(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
    client = new OpenAI({ apiKey });
  }
  return client;
}

export async function chatComplete(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  const openai = getOpenAI();
  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 4000,
  });
  return res.choices[0]?.message?.content ?? "";
}

export async function chatCompleteJSON<T>(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<T> {
  const openai = getOpenAI();
  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 4000,
    response_format: { type: "json_object" },
  });
  const text = res.choices[0]?.message?.content ?? "{}";
  return JSON.parse(text) as T;
}
