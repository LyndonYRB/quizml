import OpenAI from "openai";
import { RAG_CONFIG } from "@/lib/rag-config";
import { withOpenAIRetry } from "@/lib/openai-retry";
import type { RetrievedChunk } from "@/lib/retrieval";

type RerankResponse = {
  rankedChunkIds?: unknown;
};

function parseRerankResponse(value: string): string[] {
  const parsed = JSON.parse(value) as RerankResponse;
  if (!Array.isArray(parsed.rankedChunkIds)) return [];

  return parsed.rankedChunkIds.filter(
    (id): id is string => typeof id === "string" && id.trim().length > 0
  );
}

function contentPrefixKey(chunk: RetrievedChunk) {
  return chunk.content
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function dedupeAndBackfill(
  orderedChunks: RetrievedChunk[],
  fallbackChunks: RetrievedChunk[],
  finalChunkCount: number
) {
  const selected: RetrievedChunk[] = [];
  const seenIds = new Set<string>();
  const seenPrefixes = new Set<string>();

  for (const chunk of [...orderedChunks, ...fallbackChunks]) {
    if (seenIds.has(chunk.id)) continue;

    const prefixKey = contentPrefixKey(chunk);
    if (prefixKey && seenPrefixes.has(prefixKey)) continue;

    selected.push(chunk);
    seenIds.add(chunk.id);
    if (prefixKey) seenPrefixes.add(prefixKey);

    if (selected.length >= finalChunkCount) break;
  }

  return selected.length > 0 ? selected : fallbackChunks.slice(0, finalChunkCount);
}

function lightlyFilterWeakVectorMatches(chunks: RetrievedChunk[]) {
  const positiveScoredChunks = chunks.filter((chunk) => chunk.score > 0);
  if (positiveScoredChunks.length < 4) return chunks;

  const filtered = chunks.filter(
    (chunk) => chunk.score >= RAG_CONFIG.rerankLowScoreThreshold
  );

  return filtered.length >= 4 ? filtered : chunks;
}

export async function rerankRetrievedChunks({
  openai,
  focusTopic,
  chunks,
  finalChunkCount = 6,
}: {
  openai: OpenAI;
  focusTopic: string;
  chunks: RetrievedChunk[];
  finalChunkCount?: number;
}): Promise<{ chunks: RetrievedChunk[]; usedFallback: boolean }> {
  if (chunks.length === 0) {
    return { chunks: [], usedFallback: true };
  }

  const candidateChunks = lightlyFilterWeakVectorMatches(chunks);
  const fallbackChunks = dedupeAndBackfill(
    candidateChunks,
    chunks,
    finalChunkCount
  );
  const chunkById = new Map(candidateChunks.map((chunk) => [chunk.id, chunk]));
  const candidateList = candidateChunks
    .map(
      (chunk, index) => `Candidate ${index + 1}
id: ${chunk.id}
file: ${chunk.fileName}
chunkIndex: ${chunk.chunkIndex}
retrievalScore: ${Number.isFinite(chunk.score) ? chunk.score.toFixed(4) : "unknown"}
content:
${chunk.content.slice(0, RAG_CONFIG.rerankChunkPreviewChars)}`
    )
    .join("\n\n---\n\n");

  try {
    const completion = await withOpenAIRetry("chunk rerank", () =>
      openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a retrieval reranker. Return ONLY valid JSON. No markdown. No commentary.",
        },
        {
          role: "user",
          content: `Focus topic: "${focusTopic}"

Choose the ${finalChunkCount} best candidate chunks for generating exam-grade micro-lessons.
Rank by these priorities:
1. Direct relevance to the focus topic.
2. Specific, teachable facts over broad background.
3. Usefulness for exam-grade micro-lessons and quiz questions.
4. Non-redundancy across the selected chunks.
5. Higher retrievalScore when two chunks are otherwise similarly useful.

Avoid chunks that are mostly table of contents, bibliography, page headers, repeated boilerplate, or only weakly related.
Only include IDs from the provided candidates.

Return ONLY this JSON shape:
{"rankedChunkIds":["id1","id2"]}

Candidates:
${candidateList}`,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 500,
      })
    );

    const responseText = completion.choices?.[0]?.message?.content;
    if (!responseText) {
      return { chunks: fallbackChunks, usedFallback: true };
    }

    const rankedIds = parseRerankResponse(responseText);
    const rankedChunks = rankedIds
      .map((id) => chunkById.get(id))
      .filter((chunk): chunk is RetrievedChunk => Boolean(chunk));

    const finalChunks = dedupeAndBackfill(
      rankedChunks,
      candidateChunks,
      finalChunkCount
    );

    return {
      chunks: finalChunks,
      usedFallback: rankedChunks.length === 0,
    };
  } catch (error) {
    console.error(
      "Chunk reranking failed:",
      error instanceof Error ? error.message : "Unknown error"
    );
    return { chunks: fallbackChunks, usedFallback: true };
  }
}
