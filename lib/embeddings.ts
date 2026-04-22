import OpenAI from "openai";
import { withOpenAIRetry } from "@/lib/openai-retry";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function embedText(input: string): Promise<number[]> {
  const res = await withOpenAIRetry("embedding", () =>
    openai.embeddings.create({
      model: "text-embedding-3-small",
      input,
    })
  );

  return res.data[0].embedding;
}
