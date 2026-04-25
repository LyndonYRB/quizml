import { NextRequest, NextResponse } from "next/server";
import { splitTextIntoChunks } from "@/lib/chunking";
import {
  buildChunkRowsSequentially,
  insertChunkRowsWithVectorFallback,
} from "@/lib/ingestion-embeddings";
import {
  createRouteClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";
import {
  buildStoredFileReference,
  buildStudyMaterialStoragePath,
  deleteStoredStudyMaterialFile,
  getStudyMaterialsBucket,
  uploadStudyMaterialFile,
} from "@/lib/study-material-storage";

const MAX_PDF_BYTES_FREE = 10 * 1024 * 1024;
const MAX_PDF_BYTES_PAID = 50 * 1024 * 1024;
const MIN_EXTRACTED_CHARS = 100;

type IngestionStatus =
  | "queued"
  | "uploading"
  | "extracting"
  | "saving"
  | "chunking"
  | "ready"
  | "failed";

type SavedMaterial = {
  id: string;
  file_name: string;
  file_url: string;
  created_at: string;
};

type FileIngestError = {
  fileName: string;
  stage: string;
  message: string;
};

type StoredMaterialCleanupTarget = {
  materialId: string;
  fileName: string;
  storedFileUrl: string;
};

type StudyMaterialIngestionRow = {
  id: string;
  file_name: string;
};

function fileIdentity(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
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
    console.error("ingest-materials material cleanup failed:", {
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

async function cleanupBatchMaterials({
  supabaseAdmin,
  materials,
}: {
  supabaseAdmin: ReturnType<typeof createServiceRoleClient>;
  materials: StoredMaterialCleanupTarget[];
}) {
  for (const material of materials) {
    await cleanupMaterial({
      supabaseAdmin,
      materialId: material.materialId,
      fileName: material.fileName,
      storedFileUrl: material.storedFileUrl,
    });
  }
}

async function createIngestionRecord({
  supabaseAdmin,
  userId,
  fileName,
}: {
  supabaseAdmin: ReturnType<typeof createServiceRoleClient>;
  userId: string;
  fileName: string;
}) {
  const { data, error } = await supabaseAdmin
    .from("study_material_ingestions")
    .insert({
      user_id: userId,
      file_name: fileName,
      status: "queued",
    })
    .select("id, file_name")
    .single<StudyMaterialIngestionRow>();

  if (error || !data) {
    throw new Error(error?.message || `Failed to create ingestion record for ${fileName}.`);
  }

  return data;
}

async function updateIngestionStatus({
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
  } = {
    status,
  };

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
    console.error("ingest-materials ingestion status update failed:", {
      ingestionId,
      status,
      message: error.message,
    });
  }
}

async function failIngestionBatch({
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

export async function POST(request: NextRequest) {
  const response = NextResponse.next();

  try {
    const supabase = createRouteClient(request, response);
    const supabaseAdmin = createServiceRoleClient();
    const { data: userData, error: userErr } = await supabase.auth.getUser();

    if (userErr || !userData?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = userData.user.id;
    const { data: profile } = await supabase
      .from("profiles")
      .select("is_paid")
      .eq("user_id", userId)
      .maybeSingle();

    const isPaid = !!profile?.is_paid;
    const formData = await request.formData();
    const uploadedFiles = formData.getAll("files");

    if (uploadedFiles.length === 0) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    if (!isPaid && uploadedFiles.length !== 1) {
      return NextResponse.json(
        { error: "Free plan supports one PDF at a time." },
        { status: 400 }
      );
    }

    if (uploadedFiles.some((file) => !(file instanceof File))) {
      return NextResponse.json({ error: "Invalid file upload." }, { status: 400 });
    }

    const files = uploadedFiles as File[];
    const maxSize = isPaid ? MAX_PDF_BYTES_PAID : MAX_PDF_BYTES_FREE;

    const oversizedFile = files.find((file) => file.size > maxSize);
    if (oversizedFile) {
      return NextResponse.json(
        {
          error: `${oversizedFile.name} is too large (max ${
            maxSize / 1024 / 1024
          }MB).`,
        },
        { status: 413 }
      );
    }

    const nonPdfFile = files.find(
      (file) => file.type && file.type !== "application/pdf"
    );
    if (nonPdfFile) {
      return NextResponse.json(
        { error: "Only PDF files are supported." },
        { status: 415 }
      );
    }

    const savedMaterials: SavedMaterial[] = [];
    const chunkCounts: Record<string, number> = {};
    const fileErrors: FileIngestError[] = [];
    const studyMaterialsBucket = getStudyMaterialsBucket();
    const cleanupTargets: StoredMaterialCleanupTarget[] = [];
    const ingestionByFileKey = new Map<string, StudyMaterialIngestionRow>();

    for (const file of files) {
      try {
        const ingestion = await createIngestionRecord({
          supabaseAdmin,
          userId,
          fileName: file.name,
        });
        ingestionByFileKey.set(fileIdentity(file), ingestion);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : `Failed to create ingestion record for ${file.name}.`;
        console.error("ingest-materials ingestion record create failed:", {
          fileName: file.name,
          message,
        });
        await failIngestionBatch({
          supabaseAdmin,
          ingestionRecords: Array.from(ingestionByFileKey.values()),
          currentMessage: message,
        });
        return NextResponse.json(
          {
            success: false,
            error: message,
          },
          { status: 500 }
        );
      }
    }

    const { extractText } = await import("unpdf");

    for (const file of files) {
      const ingestion = ingestionByFileKey.get(fileIdentity(file));

      if (!ingestion) {
        return NextResponse.json(
          {
            success: false,
            error: `Missing ingestion record for ${file.name}.`,
          },
          { status: 500 }
        );
      }

      let fileBuffer: Buffer;
      try {
        const arrayBuffer = await file.arrayBuffer();
        fileBuffer = Buffer.from(arrayBuffer);

        if (fileBuffer.byteLength <= 0) {
          throw new Error("Uploaded PDF is empty.");
        }

        console.log("ingest-materials file buffer prepared:", {
          fileName: file.name,
          fileSize: file.size,
          bufferByteLength: fileBuffer.byteLength,
        });
      } catch (error) {
        const message =
          error instanceof Error && error.message === "Uploaded PDF is empty."
            ? `${file.name} is empty and could not be uploaded.`
            : `Could not prepare ${file.name} for upload.`;
        console.error("ingest-materials file buffer failed:", {
          fileName: file.name,
          fileSize: file.size,
          message,
        });
        await failIngestionBatch({
          supabaseAdmin,
          ingestionRecords: Array.from(ingestionByFileKey.values()),
          currentIngestionId: ingestion.id,
          currentMessage: message,
        });
        return NextResponse.json(
          {
            success: false,
            error: message,
          },
          { status: error instanceof Error && error.message === "Uploaded PDF is empty." ? 400 : 500 }
        );
      }

      const materialId = crypto.randomUUID();
      const storagePath = buildStudyMaterialStoragePath({
        userId,
        materialId,
        fileName: file.name,
      });
      const storedFileUrl = buildStoredFileReference(
        studyMaterialsBucket,
        storagePath
      );

      try {
        await updateIngestionStatus({
          supabaseAdmin,
          ingestionId: ingestion.id,
          status: "uploading",
          errorMessage: null,
        });

        await uploadStudyMaterialFile({
          supabase: supabaseAdmin,
          bucket: studyMaterialsBucket,
          path: storagePath,
          body: fileBuffer,
          contentType: file.type || "application/pdf",
          fileSize: file.size,
        });
      } catch (storageError) {
        const message =
          storageError instanceof Error
            ? storageError.message
            : "Failed to upload PDF to Supabase Storage.";
        console.error("study_materials file upload error:", {
          fileName: file.name,
          message,
        });
        await cleanupBatchMaterials({
          supabaseAdmin,
          materials: cleanupTargets,
        });
        await failIngestionBatch({
          supabaseAdmin,
          ingestionRecords: Array.from(ingestionByFileKey.values()),
          currentIngestionId: ingestion.id,
          currentMessage: `Could not upload ${file.name} to storage: ${message}`,
        });
        return NextResponse.json(
          {
            success: false,
            error: `Could not upload ${file.name} to storage: ${message}`,
          },
          { status: 500 }
        );
      }

      await updateIngestionStatus({
        supabaseAdmin,
        ingestionId: ingestion.id,
        status: "extracting",
        errorMessage: null,
      });

      let text = "";
      try {
        const extracted = await extractText(new Uint8Array(fileBuffer), {
          mergePages: true,
        });
        text = extracted.text ?? "";
      } catch (error) {
        console.error("ingest-materials text extraction failed:", {
          fileName: file.name,
          fileSize: file.size,
          message: error instanceof Error ? error.message : "Unknown error",
        });
        await deleteStoredStudyMaterialFile({
          supabase: supabaseAdmin,
          storedFileUrl,
        });
        await updateIngestionStatus({
          supabaseAdmin,
          ingestionId: ingestion.id,
          status: "failed",
          errorMessage: `Could not read text from ${file.name}.`,
        });
        fileErrors.push({
          fileName: file.name,
          stage: "text_extraction",
          message: `Could not read text from ${file.name}.`,
        });
        continue;
      }

      console.log("ingest-materials text extracted:", {
        fileName: file.name,
        fileSize: file.size,
        extractedTextLength: text.length,
      });

      if (!text || text.length < MIN_EXTRACTED_CHARS) {
        await deleteStoredStudyMaterialFile({
          supabase: supabaseAdmin,
          storedFileUrl,
        });
        await updateIngestionStatus({
          supabaseAdmin,
          ingestionId: ingestion.id,
          status: "failed",
          errorMessage: `Could not extract enough text from ${file.name}.`,
        });
        fileErrors.push({
          fileName: file.name,
          stage: "text_extraction",
          message: `Could not extract enough text from ${file.name}.`,
        });
        continue;
      }

      const chunks = splitTextIntoChunks(text);
      console.log("ingest-materials chunks created:", {
        fileName: file.name,
        chunkCount: chunks.length,
      });

      if (chunks.length === 0) {
        await deleteStoredStudyMaterialFile({
          supabase: supabaseAdmin,
          storedFileUrl,
        });
        await updateIngestionStatus({
          supabaseAdmin,
          ingestionId: ingestion.id,
          status: "failed",
          errorMessage: `Could not create usable chunks from ${file.name}.`,
        });
        fileErrors.push({
          fileName: file.name,
          stage: "chunking",
          message: `Could not create usable chunks from ${file.name}.`,
        });
        continue;
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
          file_name: file.name,
          file_url: storedFileUrl,
        })
        .select("id, file_name, file_url, created_at")
        .single();

      if (materialErr || !material) {
        const message =
          materialErr?.message || `Failed to create study_materials row for ${file.name}.`;
        console.error("study_materials ingest insert error:", {
          fileName: file.name,
          message,
          code: materialErr?.code,
          details: materialErr?.details,
        });
        await deleteStoredStudyMaterialFile({
          supabase: supabaseAdmin,
          storedFileUrl,
        });
        await cleanupBatchMaterials({
          supabaseAdmin,
          materials: cleanupTargets,
        });
        await failIngestionBatch({
          supabaseAdmin,
          ingestionRecords: Array.from(ingestionByFileKey.values()),
          currentIngestionId: ingestion.id,
          currentMessage: `Could not save ${file.name} after upload: ${message}`,
        });
        return NextResponse.json(
          {
            success: false,
            error: `Could not save ${file.name} after upload: ${message}`,
          },
          { status: 500 }
        );
      }

      cleanupTargets.push({
        materialId: material.id,
        fileName: file.name,
        storedFileUrl,
      });

      console.log("ingest-materials material inserted:", {
        userId,
        materialId: material.id,
        fileName: file.name,
      });

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
        embeddingSuccessCount,
        embeddingFailureCount,
        embeddingMode,
      } = await buildChunkRowsSequentially({
        chunks,
        userId,
        materialId: material.id,
        logLabel: "ingest-materials",
      });

      const chunkInsert = await insertChunkRowsWithVectorFallback({
        supabaseAdmin,
        withEmbeddings: chunkRowsWithEmbeddings,
        withoutEmbeddings: chunkRowsWithoutEmbeddings,
        logLabel: "ingest-materials",
        materialId: material.id,
      });

      if (chunkInsert.error) {
        const message =
          chunkInsert.error.message ||
          `Failed to save material chunks for ${file.name}.`;
        console.error("ingest-materials chunk insert failed:", {
          fileName: file.name,
          materialId: material.id,
          message,
        });
        await cleanupBatchMaterials({
          supabaseAdmin,
          materials: cleanupTargets,
        });
        await failIngestionBatch({
          supabaseAdmin,
          ingestionRecords: Array.from(ingestionByFileKey.values()),
          currentIngestionId: ingestion.id,
          currentMessage: `Could not save chunks for ${file.name}: ${message}`,
        });
        return NextResponse.json(
          {
            success: false,
            error: `Could not save chunks for ${file.name}: ${message}`,
          },
          { status: 500 }
        );
      }

      const { count: persistedChunkCount, error: verifyErr } = await supabaseAdmin
        .from("study_material_chunks")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("study_material_id", material.id);

      if (verifyErr || persistedChunkCount !== chunks.length) {
        console.error("ingest-materials chunk verification failed:", {
          fileName: file.name,
          materialId: material.id,
          expectedChunkCount: chunks.length,
          persistedChunkCount,
          message: verifyErr?.message,
          code: verifyErr?.code,
          details: verifyErr?.details,
        });
        await cleanupBatchMaterials({
          supabaseAdmin,
          materials: cleanupTargets,
        });
        await failIngestionBatch({
          supabaseAdmin,
          ingestionRecords: Array.from(ingestionByFileKey.values()),
          currentIngestionId: ingestion.id,
          currentMessage:
            verifyErr?.message || `Chunk verification failed for ${file.name}.`,
        });
        return NextResponse.json(
          {
            success: false,
            error:
              verifyErr?.message || `Chunk verification failed for ${file.name}.`,
          },
          { status: 500 }
        );
      }

      await updateIngestionStatus({
        supabaseAdmin,
        ingestionId: ingestion.id,
        status: "ready",
        errorMessage: null,
        studyMaterialId: material.id,
      });

      savedMaterials.push(material);
      chunkCounts[material.id] = chunks.length;

      console.log("ingest-materials chunk rows inserted:", {
        userId,
        materialId: material.id,
        withEmbeddings: chunkInsert.insertedWithEmbeddings,
        withoutEmbeddings: chunkInsert.insertedWithoutEmbeddings,
        usedVectorFallback: chunkInsert.usedVectorFallback,
        persistedChunkCount,
      });

      console.log("ingest-materials material ingested:", {
        userId,
        materialId: material.id,
        fileName: file.name,
        chunkCount: chunks.length,
        embeddingSuccessCount,
        embeddingFailureCount,
        embeddingMode,
        status: "success",
      });
    }

    if (savedMaterials.length === 0) {
      const firstError = fileErrors[0];
      return NextResponse.json(
        {
          success: false,
          error: firstError?.message || "Failed to ingest study materials.",
          fileErrors,
        },
        { status: 400 }
      );
    }

    if (fileErrors.length > 0) {
      console.warn("ingest-materials partial batch success:", {
        userId,
        savedMaterialCount: savedMaterials.length,
        failedFileCount: fileErrors.length,
        fileErrors,
      });
    }

    return NextResponse.json({
      success: true,
      studyMaterials: savedMaterials,
      chunkCounts,
      fileErrors,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("ingest-materials route error:", message);
    return NextResponse.json(
      { error: "Failed to ingest study materials: " + message },
      { status: 500 }
    );
  }
}
