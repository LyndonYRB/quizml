import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
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
import { createRouteClient } from "@/lib/supabase/server";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const DAILY_LIMIT_FREE = 5;
const DAILY_LIMIT_PAID = 9999;

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

function sanitizeMaterialIds(value: unknown) {
  if (!Array.isArray(value)) return [];

  return Array.from(
    new Set(
      value.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0
      )
    )
  ).slice(0, 25);
}

function lessonRunFileName(materials: MaterialRow[]) {
  if (materials.length === 1) return materials[0].file_name;
  return `${materials.length} materials`;
}

export async function POST(request: NextRequest) {
  const response = NextResponse.next();

  try {
    const supabase = createRouteClient(request, response);
    const { data: userData, error: userErr } = await supabase.auth.getUser();

    if (userErr || !userData?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = userData.user.id;
    const body = (await request.json().catch(() => null)) as {
      focusTopic?: unknown;
      studyMaterialIds?: unknown;
      maxChunks?: unknown;
    } | null;

    const focusTopic = sanitizeFocusTopic(body?.focusTopic);
    const studyMaterialIds = sanitizeMaterialIds(body?.studyMaterialIds);

    if (!focusTopic) {
      return NextResponse.json(
        { error: "Focus topic is required." },
        { status: 400 }
      );
    }

    if (studyMaterialIds.length === 0) {
      return NextResponse.json(
        { error: "Select at least one study material." },
        { status: 400 }
      );
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("is_paid")
      .eq("user_id", userId)
      .maybeSingle();

    const isPaid = !!profile?.is_paid;

    if (!isPaid && studyMaterialIds.length !== 1) {
      return NextResponse.json(
        { error: "Free plan supports one study material at a time." },
        { status: 400 }
      );
    }

    const { data: materials, error: materialErr } = await supabase
      .from("study_materials")
      .select("id, file_name")
      .eq("user_id", userId)
      .in("id", studyMaterialIds)
      .returns<MaterialRow[]>();

    if (materialErr) {
      console.error("generate materials read error:", materialErr.message);
      return NextResponse.json(
        { error: "Failed to load study materials." },
        { status: 500 }
      );
    }

    if ((materials ?? []).length !== studyMaterialIds.length) {
      return NextResponse.json(
        { error: "One or more selected materials were not found." },
        { status: 404 }
      );
    }

    const materialNameById = new Map(
      (materials ?? []).map((material) => [material.id, material.file_name])
    );

    const { data: chunks, error: chunkErr } = await supabase
      .from("study_material_chunks")
      .select("id, study_material_id, chunk_index, content, token_count")
      .eq("user_id", userId)
      .in("study_material_id", studyMaterialIds)
      .order("study_material_id", { ascending: true })
      .order("chunk_index", { ascending: true })
      .returns<ChunkRow[]>();

    if (chunkErr) {
      console.error("generate chunks read error:", chunkErr.message);
      return NextResponse.json(
        { error: "Failed to load material chunks." },
        { status: 500 }
      );
    }

    if (!chunks?.length) {
      return NextResponse.json(
        { error: "Selected materials have no indexed text chunks." },
        { status: 409 }
      );
    }

    const candidateChunkCount =
      typeof body?.maxChunks === "number" &&
      Number.isInteger(body.maxChunks) &&
      body.maxChunks > 0
        ? Math.min(body.maxChunks, RAG_CONFIG.maxCandidateChunkCount)
        : RAG_CONFIG.candidateChunkCount;

    let selectedChunks = await selectRelevantChunksVector({
      supabase,
      userId,
      materialIds: studyMaterialIds,
      focusTopic,
      maxChunks: candidateChunkCount,
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
        { maxChunks: candidateChunkCount, maxTokens: RAG_CONFIG.keywordFallbackTokenBudget }
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

    console.log("generate-lessons retrieval candidates:", {
      count: selectedChunks.length,
    });

    const reranked = await rerankRetrievedChunks({
      openai,
      focusTopic,
      chunks: selectedChunks,
      finalChunkCount: RAG_CONFIG.finalChunkCount,
    });
    selectedChunks = reranked.chunks;

    console.log("generate-lessons rerank result:", {
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

    console.log("generate-lessons generation succeeded:", {
      userId,
      materialCount: studyMaterialIds.length,
      selectedChunkCount: selectedChunks.length,
    });

    await upsertConceptMasteryTags(supabase, userId, generated);

    const { data: runRow, error: runErr } = await supabase
      .from("lesson_runs")
      .insert({
        user_id: userId,
        file_name: lessonRunFileName(materials ?? []),
        file_size: 0,
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

    const { error: linkErr } = await supabase.from("lesson_run_materials").insert(
      studyMaterialIds.map((studyMaterialId) => ({
        lesson_run_id: lessonRunId,
        study_material_id: studyMaterialId,
      }))
    );

    if (linkErr) {
      console.error("lesson_run_materials insert error:", linkErr.message);
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

    return NextResponse.json({
      success: true,
      lessonRunId,
      lessons: generated.lessons,
      finalTest: generated.finalTest,
      selectedChunkCount: selectedChunks.length,
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
    console.error("generate-lessons route error:", message);
    return NextResponse.json(
      { error: "Failed to generate lessons: " + message },
      { status: 500 }
    );
  }
}
