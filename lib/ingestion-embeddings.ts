import { embedText } from "@/lib/embeddings";
import type { TextChunk } from "@/lib/chunking";

export type EmbeddedChunkRow = {
  user_id: string;
  study_material_id: string;
  chunk_index: number;
  content: string;
  token_count: number;
  embedding: number[] | null;
};

export async function buildChunkRowsSequentially({
  chunks,
  userId,
  materialId,
  logLabel,
}: {
  chunks: TextChunk[];
  userId: string;
  materialId: string;
  logLabel: string;
}) {
  const chunkRows: EmbeddedChunkRow[] = [];
  let embeddingSuccessCount = 0;
  let embeddingFailureCount = 0;

  for (const chunk of chunks) {
    const embedding = await embedText(chunk.content).catch((error) => {
      embeddingFailureCount += 1;
      console.error(`${logLabel} chunk embedding failed:`, {
        materialId,
        chunkIndex: chunk.chunkIndex,
        message: error instanceof Error ? error.message : "Unknown error",
      });
      return null;
    });

    if (embedding) {
      embeddingSuccessCount += 1;
    }

    chunkRows.push({
      user_id: userId,
      study_material_id: materialId,
      chunk_index: chunk.chunkIndex,
      content: chunk.content,
      token_count: chunk.tokenCount,
      embedding,
    });
  }

  return {
    chunkRows,
    embeddingSuccessCount,
    embeddingFailureCount,
    embeddingMode: "sequential",
  };
}
