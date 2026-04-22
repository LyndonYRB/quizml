import type { SupabaseClient } from "@supabase/supabase-js";
import { estimateTokenCount } from "@/lib/chunking";
import { embedText } from "@/lib/embeddings";

const STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "because",
  "before",
  "being",
  "between",
  "could",
  "does",
  "from",
  "have",
  "into",
  "more",
  "most",
  "only",
  "that",
  "their",
  "there",
  "these",
  "this",
  "those",
  "through",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would",
]);

export type RetrievedChunk = {
  id: string;
  studyMaterialId: string;
  fileName: string;
  chunkIndex: number;
  content: string;
  tokenCount?: number | null;
  score: number;
};

type CandidateChunk = Omit<RetrievedChunk, "score">;

type VectorMatchRow = {
  id: string;
  study_material_id: string;
  chunk_index: number;
  content: string;
  token_count: number | null;
  similarity: number;
};

export function tokenizeForRetrieval(text: string): string[] {
  return (
    text
      .toLowerCase()
      .match(/[a-z0-9]{3,}/g)
      ?.filter((token) => !STOP_WORDS.has(token)) ?? []
  );
}

export function scoreChunkAgainstFocus(focusTopic: string, chunk: string) {
  const focusTokens = new Set(tokenizeForRetrieval(focusTopic));
  if (focusTokens.size === 0) return 0;

  const chunkTokens = new Set(tokenizeForRetrieval(chunk));
  let score = 0;

  for (const token of focusTokens) {
    if (chunkTokens.has(token)) score += 2;
  }

  const focusPhrase = focusTopic.trim().toLowerCase();
  if (focusPhrase.length >= 4 && chunk.toLowerCase().includes(focusPhrase)) {
    score += 4;
  }

  return score;
}

export function selectRelevantChunks(
  focusTopic: string,
  chunks: CandidateChunk[],
  options: { maxChunks?: number; maxTokens?: number } = {}
): RetrievedChunk[] {
  const maxChunks = options.maxChunks ?? 12;
  const maxTokens = options.maxTokens ?? 3200;
  const scored = chunks.map((chunk) => ({
    ...chunk,
    score: scoreChunkAgainstFocus(focusTopic, chunk.content),
  }));

  const sorted = [...scored].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.studyMaterialId !== b.studyMaterialId) {
      return a.studyMaterialId.localeCompare(b.studyMaterialId);
    }
    return a.chunkIndex - b.chunkIndex;
  });

  const pool = sorted.some((chunk) => chunk.score > 0)
    ? sorted
    : [...scored].sort((a, b) => {
        if (a.studyMaterialId !== b.studyMaterialId) {
          return a.studyMaterialId.localeCompare(b.studyMaterialId);
        }
        return a.chunkIndex - b.chunkIndex;
      });

  const selected: RetrievedChunk[] = [];
  let tokens = 0;

  for (const chunk of pool) {
    const nextTokens = chunk.tokenCount ?? estimateTokenCount(chunk.content);
    if (selected.length > 0 && tokens + nextTokens > maxTokens) continue;

    selected.push(chunk);
    tokens += nextTokens;

    if (selected.length >= maxChunks) break;
  }

  return selected;
}

export async function selectRelevantChunksVector({
  supabase,
  userId,
  materialIds,
  focusTopic,
  maxChunks = 12,
}: {
  supabase: SupabaseClient;
  userId: string;
  materialIds: string[];
  focusTopic: string;
  maxChunks?: number;
}): Promise<RetrievedChunk[] | null> {
  const queryEmbedding = await embedText(focusTopic).catch((error) => {
    console.error(
      "Embedding query failed:",
      error instanceof Error ? error.message : "Unknown error"
    );
    return null;
  });

  if (!queryEmbedding) return null;

  const { data: rawData, error } = await supabase.rpc("match_study_material_chunks", {
    query_embedding: queryEmbedding,
    match_user_id: userId,
    match_material_ids: materialIds,
    match_count: maxChunks,
  }).returns<VectorMatchRow[]>();
  const data = Array.isArray(rawData) ? rawData : null;

  if (error || !data?.length) {
    if (error) {
      console.error("Vector chunk match failed:", error.message);
    }
    return null;
  }

  return data.map((row) => ({
    id: row.id,
    studyMaterialId: row.study_material_id,
    fileName: "Study material",
    chunkIndex: row.chunk_index,
    content: row.content,
    tokenCount: row.token_count,
    score: row.similarity,
  }));
}
