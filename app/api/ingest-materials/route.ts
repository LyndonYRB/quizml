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

const MAX_PDF_BYTES_FREE = 10 * 1024 * 1024;
const MAX_PDF_BYTES_PAID = 50 * 1024 * 1024;
const MIN_EXTRACTED_CHARS = 100;
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "";

type SavedMaterial = {
  id: string;
  file_name: string;
  file_url: string;
  created_at: string;
};

function materialUrl(materialId: string) {
  return APP_URL
    ? `${APP_URL}/?studyMaterialId=${encodeURIComponent(materialId)}`
    : `/?studyMaterialId=${encodeURIComponent(materialId)}`;
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

    for (const file of files) {
      let text = "";
      try {
        const bytes = await file.arrayBuffer();
        const extracted = await extractText(new Uint8Array(bytes), {
          mergePages: true,
        });
        text = extracted.text ?? "";
      } catch (error) {
        console.error("ingest-materials text extraction failed:", {
          fileName: file.name,
          fileSize: file.size,
          message: error instanceof Error ? error.message : "Unknown error",
        });
        return NextResponse.json(
          { error: `Could not read text from ${file.name}.` },
          { status: 400 }
        );
      }

      console.log("ingest-materials text extracted:", {
        fileName: file.name,
        fileSize: file.size,
        extractedTextLength: text.length,
      });

      if (!text || text.length < MIN_EXTRACTED_CHARS) {
        return NextResponse.json(
          { error: `Could not extract enough text from ${file.name}.` },
          { status: 400 }
        );
      }

      const chunks = splitTextIntoChunks(text);
      console.log("ingest-materials chunks created:", {
        fileName: file.name,
        chunkCount: chunks.length,
      });

      if (chunks.length === 0) {
        return NextResponse.json(
          { error: `Could not create usable chunks from ${file.name}.` },
          { status: 400 }
        );
      }

      const materialId = crypto.randomUUID();
      const { data: material, error: materialErr } = await supabaseAdmin
        .from("study_materials")
        .insert({
          id: materialId,
          user_id: userId,
          file_name: file.name,
          file_url: materialUrl(materialId),
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
        return NextResponse.json(
          { error: "Failed to save study material." },
          { status: 500 }
        );
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
        return NextResponse.json(
          { error: "Failed to save material chunks." },
          { status: 500 }
        );
      }

      savedMaterials.push(material);
      chunkCounts[material.id] = chunks.length;

      console.log("ingest-materials chunk rows inserted:", {
        userId,
        materialId: material.id,
        withEmbeddings: chunkInsert.insertedWithEmbeddings,
        withoutEmbeddings: chunkInsert.insertedWithoutEmbeddings,
      });

      console.log("ingest-materials material ingested:", {
        userId,
        materialId: material.id,
        fileName: file.name,
        chunkCount: chunks.length,
        embeddingSuccessCount,
        embeddingFailureCount,
        embeddingMode,
      });
    }

    return NextResponse.json({
      success: true,
      studyMaterials: savedMaterials,
      chunkCounts,
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
