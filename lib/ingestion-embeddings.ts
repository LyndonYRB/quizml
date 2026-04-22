import { embedText } from "@/lib/embeddings";
import type { TextChunk } from "@/lib/chunking";

type BaseChunkRow = {
  user_id: string;
  study_material_id: string;
  chunk_index: number;
  content: string;
  token_count: number;
};

export type EmbeddedChunkRow = BaseChunkRow & {
  embedding: number[];
};

export type UnembeddedChunkRow = BaseChunkRow;

function isValidEmbedding(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === 1536 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

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
  const chunkRowsWithEmbeddings: EmbeddedChunkRow[] = [];
  const chunkRowsWithoutEmbeddings: UnembeddedChunkRow[] = [];
  let embeddingSuccessCount = 0;
  let embeddingFailureCount = 0;

  for (const chunk of chunks) {
    let embedding: number[] | null = null;
    const baseRow: UnembeddedChunkRow = {
      user_id: userId,
      study_material_id: materialId,
      chunk_index: chunk.chunkIndex,
      content: chunk.content,
      token_count: chunk.tokenCount,
    };

    const embeddingResult: unknown = await embedText(chunk.content).catch((error) => {
      embeddingFailureCount += 1;
      console.error(`${logLabel} chunk embedding failed:`, {
        materialId,
        chunkIndex: chunk.chunkIndex,
        message: error instanceof Error ? error.message : "Unknown error",
      });
      return null;
    });

    if (isValidEmbedding(embeddingResult)) {
      embedding = embeddingResult;
      embeddingSuccessCount += 1;
    } else if (embeddingResult !== null) {
      embeddingFailureCount += 1;
      console.error(`${logLabel} chunk embedding invalid shape:`, {
        materialId,
        chunkIndex: chunk.chunkIndex,
        length: Array.isArray(embeddingResult) ? embeddingResult.length : null,
      });
    }

    if (embedding) {
      chunkRowsWithEmbeddings.push({ ...baseRow, embedding });
    } else {
      chunkRowsWithoutEmbeddings.push(baseRow);
    }
  }

  return {
    chunkRowsWithEmbeddings,
    chunkRowsWithoutEmbeddings,
    embeddingSuccessCount,
    embeddingFailureCount,
    embeddingMode: "sequential",
  };
}
