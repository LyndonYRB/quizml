import { splitTextIntoChunks } from "./chunking";
import {
  buildChunkRowsSequentially,
  insertChunkRowsWithVectorFallback,
} from "./ingestion-embeddings";
import { createServiceRoleClient } from "./supabase/server";
import {
  downloadStoredStudyMaterialFile,
  deleteStoredStudyMaterialFile,
  getStudyMaterialsBucket,
} from "./study-material-storage";

const MIN_EXTRACTED_CHARS = 100;

export type IngestionStatus =
  | "queued"
  | "uploading"
  | "extracting"
  | "saving"
  | "chunking"
  | "ready"
  | "failed";

export type StudyMaterialIngestionRow = {
  id: string;
  client_file_id: string | null;
  file_name: string;
};

export type StudyMaterialIngestionJobFile = {
  clientFileId: string;
  fileName: string;
  materialId: string;
  storagePath: string;
  storedFileUrl: string;
};

export type StudyMaterialIngestionJobPayload = {
  userId: string;
  files: StudyMaterialIngestionJobFile[];
};

export async function createIngestionRecord({
  supabaseAdmin,
  userId,
  clientFileId,
  fileName,
}: {
  supabaseAdmin: ReturnType<typeof createServiceRoleClient>;
  userId: string;
  clientFileId: string | null;
  fileName: string;
}) {
  const { data, error } = await supabaseAdmin
    .from("study_material_ingestions")
    .insert({
      user_id: userId,
      client_file_id: clientFileId,
      file_name: fileName,
      status: "queued",
    })
    .select("id, client_file_id, file_name")
    .single<StudyMaterialIngestionRow>();

  if (error || !data) {
    throw new Error(
      error?.message || `Failed to create ingestion record for ${fileName}.`
    );
  }

  return data;
}

export async function updateIngestionStatus({
  supabaseAdmin,
  ingestionId,
  status,
  errorMessage,
  studyMaterialId,
}: {
  supabaseAdmin: ReturnType<typeof createServiceRoleClient>;
  ingestionId: string;
  status: IngestionStatus;
  errorMessage?: string | null;
  studyMaterialId?: string | null;
}) {
  const updates: {
    status: IngestionStatus;
    error_message?: string | null;
    study_material_id?: string | null;
  } = { status };

  if (errorMessage !== undefined) {
    updates.error_message = errorMessage;
  }

  if (studyMaterialId !== undefined) {
    updates.study_material_id = studyMaterialId;
  }

  const { error } = await supabaseAdmin
    .from("study_material_ingestions")
    .update(updates)
    .eq("id", ingestionId);

  if (error) {
    console.error("ingestion status update failed:", {
      ingestionId,
      status,
      message: error.message,
    });
  }
}

export async function failIngestionBatch({
  supabaseAdmin,
  ingestionRecords,
  currentIngestionId,
  currentMessage,
}: {
  supabaseAdmin: ReturnType<typeof createServiceRoleClient>;
  ingestionRecords: StudyMaterialIngestionRow[];
  currentIngestionId?: string;
  currentMessage: string;
}) {
  for (const ingestion of ingestionRecords) {
    await updateIngestionStatus({
      supabaseAdmin,
      ingestionId: ingestion.id,
      status: "failed",
      errorMessage:
        ingestion.id === currentIngestionId
          ? currentMessage
          : "Rolled back because this ingestion request did not complete.",
    });
  }
}

async function cleanupMaterial({
  supabaseAdmin,
  materialId,
  fileName,
  storedFileUrl,
}: {
  supabaseAdmin: ReturnType<typeof createServiceRoleClient>;
  materialId: string;
  fileName: string;
  storedFileUrl?: string | null;
}) {
  const { error } = await supabaseAdmin
    .from("study_materials")
    .delete()
    .eq("id", materialId);

  if (error) {
    console.error("study material cleanup failed:", {
      fileName,
      materialId,
      message: error.message,
    });
  }

  await deleteStoredStudyMaterialFile({
    supabase: supabaseAdmin,
    storedFileUrl,
  });
}

async function processSingleQueuedFile({
  supabaseAdmin,
  userId,
  ingestion,
  file,
  studyMaterialsBucket,
}: {
  supabaseAdmin: ReturnType<typeof createServiceRoleClient>;
  userId: string;
  ingestion: StudyMaterialIngestionRow;
  file: StudyMaterialIngestionJobFile;
  studyMaterialsBucket: string;
}) {
  let materialId: string | null = null;
  let storedFileUrl: string | null = null;

  try {
    materialId = file.materialId;
    storedFileUrl = file.storedFileUrl;

    await updateIngestionStatus({
      supabaseAdmin,
      ingestionId: ingestion.id,
      status: "uploading",
      errorMessage: null,
    });

    const { buffer: fileBuffer } = await downloadStoredStudyMaterialFile({
      supabase: supabaseAdmin,
    });

    await updateIngestionStatus({
      supabaseAdmin,
      ingestionId: ingestion.id,
      status: "extracting",
      errorMessage: null,
    });

    const { extractText } = await import("unpdf");
    const extracted = await extractText(new Uint8Array(fileBuffer), {
      mergePages: true,
    });
    const text = extracted.text ?? "";

    if (!text || text.length < MIN_EXTRACTED_CHARS) {
      throw new Error(`Could not extract enough text from ${file.fileName}.`);
    }

    const chunks = splitTextIntoChunks(text);
    if (chunks.length === 0) {
      throw new Error(`Could not create usable chunks from ${file.fileName}.`);
    }

    await updateIngestionStatus({
      supabaseAdmin,
      ingestionId: ingestion.id,
      status: "saving",
      errorMessage: null,
    });

    const { data: material, error: materialErr } = await supabaseAdmin
      .from("study_materials")
      .insert({
        id: materialId,
        user_id: userId,
        file_name: file.fileName,
        file_url: storedFileUrl,
      })
      .select("id")
      .single<{ id: string }>();

    if (materialErr || !material) {
      throw new Error(
        materialErr?.message ||
          `Failed to create study_materials row for ${file.fileName}.`
      );
    }

    await updateIngestionStatus({
      supabaseAdmin,
      ingestionId: ingestion.id,
      status: "chunking",
      errorMessage: null,
      studyMaterialId: material.id,
    });

    const {
      chunkRowsWithEmbeddings,
      chunkRowsWithoutEmbeddings,
    } = await buildChunkRowsSequentially({
      chunks,
      userId,
      materialId: material.id,
      logLabel: "worker-ingest",
    });

    const chunkInsert = await insertChunkRowsWithVectorFallback({
      supabaseAdmin,
      withEmbeddings: chunkRowsWithEmbeddings,
      withoutEmbeddings: chunkRowsWithoutEmbeddings,
      logLabel: "worker-ingest",
      materialId: material.id,
    });

    if (chunkInsert.error) {
      throw new Error(
        chunkInsert.error.message ||
          `Failed to save material chunks for ${file.fileName}.`
      );
    }

    const { count: persistedChunkCount, error: verifyErr } = await supabaseAdmin
      .from("study_material_chunks")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("study_material_id", material.id);

    if (verifyErr || persistedChunkCount !== chunks.length) {
      throw new Error(
        verifyErr?.message || `Chunk verification failed for ${file.fileName}.`
      );
    }

    await updateIngestionStatus({
      supabaseAdmin,
      ingestionId: ingestion.id,
      status: "ready",
      errorMessage: null,
      studyMaterialId: material.id,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : `Failed to ingest ${file.fileName}.`;

    console.error("worker study material ingestion failed:", {
      userId,
      clientFileId: file.clientFileId,
      fileName: file.fileName,
      message,
    });

    if (materialId) {
      await cleanupMaterial({
        supabaseAdmin,
        materialId,
        fileName: file.fileName,
        storedFileUrl,
      });
    } else if (storedFileUrl) {
      await deleteStoredStudyMaterialFile({
        supabase: supabaseAdmin,
        storedFileUrl,
      });
    }

    await updateIngestionStatus({
      supabaseAdmin,
      ingestionId: ingestion.id,
      status: "failed",
      errorMessage: message,
    });
  }
}

export async function processStudyMaterialIngestionJob(
  payload: StudyMaterialIngestionJobPayload
) {
  const supabaseAdmin = createServiceRoleClient();
  const studyMaterialsBucket = getStudyMaterialsBucket();

  for (const file of payload.files) {
    const { data: ingestion, error } = await supabaseAdmin
      .from("study_material_ingestions")
      .select("id, client_file_id, file_name")
      .eq("user_id", payload.userId)
      .eq("client_file_id", file.clientFileId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<StudyMaterialIngestionRow>();

    if (error || !ingestion) {
      console.error("worker could not find ingestion row:", {
        userId: payload.userId,
        clientFileId: file.clientFileId,
        fileName: file.fileName,
        message: error?.message,
      });
      continue;
    }

    await processSingleQueuedFile({
      supabaseAdmin,
      userId: payload.userId,
      ingestion,
      file,
      studyMaterialsBucket,
    });
  }
}
