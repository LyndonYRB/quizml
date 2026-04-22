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

type SupabaseInsertClient = {
  from: (table: string) => {
    insert: (rows: EmbeddedChunkRow[] | UnembeddedChunkRow[]) => PromiseLike<{
      error: { message?: string; code?: string; details?: string } | null;
    }>;
  };
};

function isValidEmbedding(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === 1536 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

function toSafeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : fallback;
}

function stripEmbedding(row: EmbeddedChunkRow): UnembeddedChunkRow {
  return {
    user_id: row.user_id,
    study_material_id: row.study_material_id,
    chunk_index: row.chunk_index,
    content: row.content,
    token_count: row.token_count,
  };
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
      chunk_index: toSafeInteger(
        chunk.chunkIndex,
        chunkRowsWithEmbeddings.length + chunkRowsWithoutEmbeddings.length
      ),
      content: chunk.content,
      token_count: toSafeInteger(chunk.tokenCount, 0),
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

export async function insertChunkRowsWithVectorFallback({
  supabaseAdmin,
  withEmbeddings,
  withoutEmbeddings,
  logLabel,
  materialId,
}: {
  supabaseAdmin: SupabaseInsertClient;
  withEmbeddings: EmbeddedChunkRow[];
  withoutEmbeddings: UnembeddedChunkRow[];
  logLabel: string;
  materialId: string;
}) {
  let insertedWithEmbeddings = 0;
  let insertedWithoutEmbeddings = 0;
  let usedVectorFallback = false;
  const fallbackRows = [...withoutEmbeddings];

  if (withEmbeddings.length > 0) {
    const { error } = await supabaseAdmin
      .from("study_material_chunks")
      .insert(withEmbeddings);

    if (error) {
      console.error(`${logLabel} study_material_chunks vector insert failed:`, {
        materialId,
        rowCount: withEmbeddings.length,
        code: error.code,
        message: error.message,
        details: error.details,
      });
      usedVectorFallback = true;
      fallbackRows.push(...withEmbeddings.map(stripEmbedding));
    } else {
      insertedWithEmbeddings = withEmbeddings.length;
    }
  }

  if (fallbackRows.length > 0) {
    const { error } = await supabaseAdmin
      .from("study_material_chunks")
      .insert(fallbackRows);

    if (error) {
      console.error(`${logLabel} study_material_chunks non-vector insert failed:`, {
        materialId,
        rowCount: fallbackRows.length,
        code: error.code,
        message: error.message,
        details: error.details,
      });
      return { error };
    }

    insertedWithoutEmbeddings = fallbackRows.length;
  }

  return {
    error: null,
    insertedWithEmbeddings,
    insertedWithoutEmbeddings,
    usedVectorFallback,
  };
}
