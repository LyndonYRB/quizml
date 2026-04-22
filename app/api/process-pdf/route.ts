// app/api/process-pdf/route.ts
// Temporary compatibility endpoint.
// It accepts the legacy PDF FormData shape, but generation still happens only
// from stored study_material_chunks selected through retrieval.
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { splitTextIntoChunks } from "@/lib/chunking";
import {
  buildChunkRowsSequentially,
  insertChunkRowsWithVectorFallback,
} from "@/lib/ingestion-embeddings";
import {
  generateValidatedLessonSet,
  LESSON_RUN_SCHEMA_VERSION,
  upsertConceptMasteryTags,
} from "@/lib/lesson-generation";
import {
  selectRelevantChunks,
  selectRelevantChunksVector,
} from "@/lib/retrieval";
import { rerankRetrievedChunks } from "@/lib/rerank";
import { RAG_CONFIG } from "@/lib/rag-config";
import {
  createRouteClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MAX_PDF_BYTES_FREE = 10 * 1024 * 1024;
const MAX_PDF_BYTES_PAID = 50 * 1024 * 1024;
const DAILY_LIMIT_FREE = 5;
const DAILY_LIMIT_PAID = 9999;
const MIN_EXTRACTED_CHARS = 100;
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "";

type MaterialRow = {
  id: string;
  file_name: string;
};

type ChunkRow = {
  id: string;
  study_material_id: string;
  chunk_index: number;
  content: string;
  token_count: number | null;
};

function utcTodayISODate(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function sanitizeFocusTopic(input: unknown): string {
  const raw = typeof input === "string" ? input : "";
  return raw
    .slice(0, 200)
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
}

function materialUrl(materialId: string) {
  return APP_URL
    ? `${APP_URL}/?studyMaterialId=${encodeURIComponent(materialId)}`
    : `/?studyMaterialId=${encodeURIComponent(materialId)}`;
}

function lessonRunFileName(materials: MaterialRow[]) {
  if (materials.length === 1) return materials[0].file_name;
  return `${materials.length} materials`;
}

function totalFileSize(files: File[]) {
  return files.reduce((total, file) => total + file.size, 0);
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
      .select("is_paid, plan")
      .eq("user_id", userId)
      .maybeSingle();

    const isPaid = !!profile?.is_paid;

    console.log("process-pdf profile loaded:", {
      userId,
      isPaid,
      plan: profile?.plan ?? null,
    });

    const formData = await request.formData();
    const uploadedFiles = formData.getAll("files");
    const focusTopic = sanitizeFocusTopic(formData.get("focusTopic"));

    if (!focusTopic) {
      return NextResponse.json(
        { error: "Focus topic is required." },
        { status: 400 }
      );
    }

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

    console.log("process-pdf file validated:", {
      fileNames: files.map((file) => file.name),
      totalFileSize: totalFileSize(files),
    });

    const { extractText } = await import("unpdf");
    const savedMaterials: MaterialRow[] = [];

    for (const file of files) {
      let text = "";
      try {
        const bytes = await file.arrayBuffer();
        const extracted = await extractText(new Uint8Array(bytes), {
          mergePages: true,
        });
        text = extracted.text ?? "";
      } catch (error) {
        console.error("process-pdf text extraction failed:", {
          fileName: file.name,
          fileSize: file.size,
          message: error instanceof Error ? error.message : "Unknown error",
        });
        return NextResponse.json(
          { error: `Could not read text from ${file.name}.` },
          { status: 400 }
        );
      }

      console.log("process-pdf text extracted:", {
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
      console.log("process-pdf chunks created:", {
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
        .select("id, file_name")
        .single();

      if (materialErr || !material) {
        console.error("process-pdf study_materials insert failed:", {
          fileName: file.name,
          message: materialErr?.message,
          code: materialErr?.code,
          details: materialErr?.details,
        });
        return NextResponse.json(
          { error: "Failed to store study material." },
          { status: 500 }
        );
      }

      console.log("process-pdf material inserted:", {
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
        logLabel: "process-pdf",
      });

      const chunkInsert = await insertChunkRowsWithVectorFallback({
        supabaseAdmin,
        withEmbeddings: chunkRowsWithEmbeddings,
        withoutEmbeddings: chunkRowsWithoutEmbeddings,
        logLabel: "process-pdf",
        materialId: material.id,
      });

      if (chunkInsert.error) {
        return NextResponse.json(
          { error: "Failed to store study material chunks." },
          { status: 500 }
        );
      }

      savedMaterials.push(material);

      console.log("process-pdf chunk rows inserted:", {
        userId,
        materialId: material.id,
        withEmbeddings: chunkInsert.insertedWithEmbeddings,
        withoutEmbeddings: chunkInsert.insertedWithoutEmbeddings,
      });

      console.log("process-pdf material ingested:", {
        userId,
        materialId: material.id,
        fileName: file.name,
        chunkCount: chunks.length,
        embeddingSuccessCount,
        embeddingFailureCount,
        embeddingMode,
      });
    }

    const materialIds = savedMaterials.map((material) => material.id);

    const { data: chunks, error: chunkReadErr } = await supabase
      .from("study_material_chunks")
      .select("id, study_material_id, chunk_index, content, token_count")
      .eq("user_id", userId)
      .in("study_material_id", materialIds)
      .order("study_material_id", { ascending: true })
      .order("chunk_index", { ascending: true })
      .returns<ChunkRow[]>();

    if (chunkReadErr) {
      console.error("process-pdf chunk retrieval error:", chunkReadErr.message);
      return NextResponse.json(
        { error: "Failed to retrieve material chunks." },
        { status: 500 }
      );
    }

    if (!chunks?.length) {
      return NextResponse.json(
        { error: "Stored materials have no indexed text chunks." },
        { status: 409 }
      );
    }

    const materialNameById = new Map(
      savedMaterials.map((material) => [material.id, material.file_name])
    );
    let selectedChunks = await selectRelevantChunksVector({
      supabase,
      userId,
      materialIds,
      focusTopic,
      maxChunks: RAG_CONFIG.candidateChunkCount,
    });

    if (!selectedChunks || selectedChunks.length === 0) {
      selectedChunks = selectRelevantChunks(
        focusTopic,
        chunks.map((chunk) => ({
          id: chunk.id,
          studyMaterialId: chunk.study_material_id,
          fileName: materialNameById.get(chunk.study_material_id) ?? "Study material",
          chunkIndex: chunk.chunk_index,
          content: chunk.content,
          tokenCount: chunk.token_count,
        })),
        {
          maxChunks: RAG_CONFIG.candidateChunkCount,
          maxTokens: RAG_CONFIG.keywordFallbackTokenBudget,
        }
      );
    } else {
      selectedChunks = selectedChunks.map((chunk) => ({
        ...chunk,
        fileName: materialNameById.get(chunk.studyMaterialId) ?? "Study material",
      }));
    }

    if (selectedChunks.length === 0) {
      return NextResponse.json(
        { error: "No relevant material chunks were available." },
        { status: 409 }
      );
    }

    console.log("process-pdf retrieval candidates:", {
      count: selectedChunks.length,
    });

    const reranked = await rerankRetrievedChunks({
      openai,
      focusTopic,
      chunks: selectedChunks,
      finalChunkCount: RAG_CONFIG.finalChunkCount,
    });
    selectedChunks = reranked.chunks;

    console.log("process-pdf rerank result:", {
      count: selectedChunks.length,
      fallback: reranked.usedFallback,
    });

    const day = utcTodayISODate();
    const { data: rpcData, error: rpcErr } = await supabase.rpc(
      "increment_daily_generation",
      {
        p_user_id: userId,
        p_day: day,
        p_limit: isPaid ? DAILY_LIMIT_PAID : DAILY_LIMIT_FREE,
      }
    );

    if (rpcErr) {
      console.error("Usage RPC error:", rpcErr.message);
      return NextResponse.json({ error: "Failed usage check." }, { status: 500 });
    }

    const row = Array.isArray(rpcData) ? rpcData[0] : rpcData;
    const allowed = !!row?.allowed;
    const generations = Number(row?.generations ?? 0);

    if (!allowed) {
      return NextResponse.json(
        {
          error: isPaid
            ? "Daily generation limit reached."
            : "Daily generation limit reached. Consider upgrading for more usage.",
          usage: {
            limit: isPaid ? DAILY_LIMIT_PAID : DAILY_LIMIT_FREE,
            used: generations,
            remaining: 0,
            day,
          },
        },
        { status: 429 }
      );
    }

    const materialContext = selectedChunks
      .map(
        (chunk) =>
          `===== FILE: ${chunk.fileName} | CHUNK ${chunk.chunkIndex} =====\n${chunk.content}`
      )
      .join("\n\n");

    const generated = await generateValidatedLessonSet(
      openai,
      focusTopic,
      materialContext
    );

    console.log("process-pdf generation succeeded:", {
      userId,
      materialCount: materialIds.length,
      selectedChunkCount: selectedChunks.length,
    });

    await upsertConceptMasteryTags(supabase, userId, generated);

    const { data: runRow, error: runErr } = await supabase
      .from("lesson_runs")
      .insert({
        user_id: userId,
        file_name: lessonRunFileName(savedMaterials),
        file_size: totalFileSize(files),
        focus_topic: focusTopic,
        lessons_json: {
          schemaVersion: LESSON_RUN_SCHEMA_VERSION,
          lessons: generated.lessons,
          finalTest: generated.finalTest,
        },
      })
      .select("id")
      .single();

    if (runErr || !runRow?.id) {
      console.error("lesson_runs insert error:", runErr?.message);
      return NextResponse.json(
        { error: "Failed to store lesson run." },
        { status: 500 }
      );
    }

    const lessonRunId = runRow.id;
    const fileUrl = APP_URL
      ? `${APP_URL}/?lessonRunId=${encodeURIComponent(lessonRunId)}`
      : `/?lessonRunId=${encodeURIComponent(lessonRunId)}`;

    console.log("process-pdf study_materials insert starting:", {
      userId,
      isPaid,
      fileNames: files.map((file) => file.name),
      lessonRunId,
      fileUrl,
    });

    const { error: materialLinkErr } = await supabase
      .from("lesson_run_materials")
      .insert(
        materialIds.map((studyMaterialId) => ({
          lesson_run_id: lessonRunId,
          study_material_id: studyMaterialId,
        }))
      );

    if (materialLinkErr) {
      console.error("lesson_run_materials insert error:", materialLinkErr.message);
      return NextResponse.json(
        { error: "Failed to link lesson run materials." },
        { status: 500 }
      );
    }

    const { error: chunkLinkErr } = await supabase.from("lesson_run_chunks").insert(
      selectedChunks.map((chunk, index) => ({
        lesson_run_id: lessonRunId,
        study_material_chunk_id: chunk.id,
        rank: index + 1,
      }))
    );

    if (chunkLinkErr) {
      console.error("lesson_run_chunks insert error:", chunkLinkErr.message);
      return NextResponse.json(
        { error: "Failed to link lesson run chunks." },
        { status: 500 }
      );
    }

    console.log("process-pdf study_materials insert succeeded");

    return NextResponse.json({
      success: true,
      lessonRunId,
      lessons: generated.lessons,
      finalTest: generated.finalTest,
      selectedChunkCount: selectedChunks.length,
      studyMaterialIds: materialIds,
      usage: {
        limit: isPaid ? DAILY_LIMIT_PAID : DAILY_LIMIT_FREE,
        used: generations,
        remaining: Math.max(
          0,
          (isPaid ? DAILY_LIMIT_PAID : DAILY_LIMIT_FREE) - generations
        ),
        day,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Error processing PDF:", message);
    return NextResponse.json(
      { error: "Failed to process PDF: " + message },
      { status: 500 }
    );
  }
}
