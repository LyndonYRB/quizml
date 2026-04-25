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

    const { extractText } = await import("unpdf");
    const savedMaterials: SavedMaterial[] = [];
    const chunkCounts: Record<string, number> = {};
    const fileErrors: FileIngestError[] = [];
    const studyMaterialsBucket = getStudyMaterialsBucket();

    for (const file of files) {
      let text = "";
      let fileBytes: Uint8Array | null = null;
      try {
        const bytes = await file.arrayBuffer();
        fileBytes = new Uint8Array(bytes);
        const extracted = await extractText(fileBytes, {
          mergePages: true,
        });
        text = extracted.text ?? "";
      } catch (error) {
        console.error("ingest-materials text extraction failed:", {
          fileName: file.name,
          fileSize: file.size,
          message: error instanceof Error ? error.message : "Unknown error",
        });
        fileErrors.push({
          fileName: file.name,
          stage: "text_extraction",
          message: `Could not read text from ${file.name}.`,
        });
        console.warn("ingest-materials file failed:", {
          fileName: file.name,
          stage: "text_extraction",
        });
        continue;
      }

      console.log("ingest-materials text extracted:", {
        fileName: file.name,
        fileSize: file.size,
        extractedTextLength: text.length,
      });

      if (!text || text.length < MIN_EXTRACTED_CHARS) {
        fileErrors.push({
          fileName: file.name,
          stage: "text_extraction",
          message: `Could not extract enough text from ${file.name}.`,
        });
        console.warn("ingest-materials file failed:", {
          fileName: file.name,
          stage: "text_extraction",
          extractedTextLength: text.length,
        });
        continue;
      }

      const chunks = splitTextIntoChunks(text);
      console.log("ingest-materials chunks created:", {
        fileName: file.name,
        chunkCount: chunks.length,
      });

      if (chunks.length === 0) {
        fileErrors.push({
          fileName: file.name,
          stage: "chunking",
          message: `Could not create usable chunks from ${file.name}.`,
        });
        console.warn("ingest-materials file failed:", {
          fileName: file.name,
          stage: "chunking",
          chunkCount: chunks.length,
        });
        continue;
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
        await uploadStudyMaterialFile({
          supabase: supabaseAdmin,
          bucket: studyMaterialsBucket,
          path: storagePath,
          body: fileBytes ?? new Uint8Array(),
          contentType: file.type || "application/pdf",
        });
      } catch (storageError) {
        console.error("study_materials file upload error:", {
          fileName: file.name,
          message:
            storageError instanceof Error
              ? storageError.message
              : "Unknown storage error",
        });
        fileErrors.push({
          fileName: file.name,
          stage: "file_upload",
          message:
            storageError instanceof Error
              ? storageError.message
              : "Failed to store uploaded PDF.",
        });
        console.warn("ingest-materials file failed:", {
          fileName: file.name,
          stage: "file_upload",
        });
        continue;
      }

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
        console.error("study_materials ingest insert error:", {
          fileName: file.name,
          message: materialErr?.message,
          code: materialErr?.code,
          details: materialErr?.details,
        });
        fileErrors.push({
          fileName: file.name,
          stage: "material_insert",
          message: materialErr?.message || "Failed to save study material.",
        });
        console.warn("ingest-materials file failed:", {
          fileName: file.name,
          stage: "material_insert",
        });
        await deleteStoredStudyMaterialFile({
          supabase: supabaseAdmin,
          storedFileUrl,
        });
        continue;
      }

      console.log("ingest-materials material inserted:", {
        userId,
        materialId: material.id,
        fileName: file.name,
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
        fileErrors.push({
          fileName: file.name,
          stage: "chunk_insert",
          message: chunkInsert.error.message || "Failed to save material chunks.",
        });

        console.warn("ingest-materials file failed:", {
          fileName: file.name,
          materialId: material.id,
          stage: "chunk_insert",
        });
        await cleanupMaterial({
          supabaseAdmin,
          materialId: material.id,
          fileName: file.name,
          storedFileUrl,
        });
        continue;
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
        fileErrors.push({
          fileName: file.name,
          stage: "chunk_verify",
          message:
            verifyErr?.message ||
            `Expected ${chunks.length} chunks but found ${persistedChunkCount ?? 0}.`,
        });
        console.warn("ingest-materials file failed:", {
          fileName: file.name,
          materialId: material.id,
          stage: "chunk_verify",
        });
        await cleanupMaterial({
          supabaseAdmin,
          materialId: material.id,
          fileName: file.name,
          storedFileUrl,
        });
        continue;
      }

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
