// app/api/attempt/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createRouteClient } from "@/lib/supabase/server";
import { normalizeConcept } from "@/lib/concepts";

/* =========================================================
   TYPES
========================================================= */

type AttemptPayload = {
  lessonRunId?: string | null;
  source: "lesson_mastered" | "final_attempted";
  attempts: {
    conceptTag: string;
    question: string;
    selectedAnswer: number | null;
    correctAnswer: number;
  }[];
};

type NormalizedAttempt = {
  conceptTag: string;
  question: string;
  selectedAnswer: number | null;
  correctAnswer: number;
  isCorrect: boolean;
};

function safeText(x: unknown, max = 4000) {
  const s = typeof x === "string" ? x : "";
  return s.replace(/[\u0000-\u001F\u007F]/g, "").slice(0, max).trim();
}

function safeInt(x: unknown) {
  if (typeof x === "number" && Number.isFinite(x)) return Math.trunc(x);
  if (typeof x === "string" && x.trim() !== "" && !Number.isNaN(Number(x)))
    return Math.trunc(Number(x));
  return null;
}

/**
 * Simple spaced repetition schedule:
 * - Correct: streak++, next review after {1d, 3d, 7d, 14d, 30d}
 * - Wrong: streak=0, next review in 6h (quick retry)
 */
function computeNextReview(streak: number, wasCorrect: boolean) {
  const now = new Date();
  const ms = (n: number) => n * 60 * 60 * 1000;

  if (!wasCorrect) {
    return new Date(now.getTime() + ms(6)); // 6 hours
  }

  const daysByStreak = [1, 3, 7, 14, 30]; // streak 1..5+
  const idx = Math.min(Math.max(streak, 1), 5) - 1;
  const days = daysByStreak[idx];

  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

/* =========================================================
   ROUTE: POST /api/attempt
========================================================= */

export async function POST(req: NextRequest) {
  const res = NextResponse.next();

  try {
    const supabase = createRouteClient(req, res);
    const { data: userData, error: userErr } = await supabase.auth.getUser();

    if (userErr || !userData?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = userData.user.id;

    const body = (await req.json().catch(() => null)) as AttemptPayload | null;

    if (!body) {
      return NextResponse.json({ error: "Missing JSON body" }, { status: 400 });
    }

    if (
      body.source !== "lesson_mastered" &&
      body.source !== "final_attempted"
    ) {
      return NextResponse.json({ error: "Missing valid attempt source" }, { status: 400 });
    }

    if (!Array.isArray(body.attempts) || body.attempts.length === 0) {
      return NextResponse.json({ error: "Missing attempts" }, { status: 400 });
    }

    const attempts: NormalizedAttempt[] = [];

    for (const attempt of body.attempts) {
      const conceptTag = safeText(attempt.conceptTag, 120);
      const question = safeText(attempt.question, 2000);
      const selectedAnswerRaw = attempt.selectedAnswer;
      const selectedAnswer =
        selectedAnswerRaw === null || selectedAnswerRaw === undefined
          ? null
          : safeInt(selectedAnswerRaw);
      const correctAnswer = safeInt(attempt.correctAnswer);

      if (!conceptTag) {
        return NextResponse.json({ error: "Missing conceptTag" }, { status: 400 });
      }
      if (!question) {
        return NextResponse.json({ error: "Missing question" }, { status: 400 });
      }
      if (correctAnswer === null) {
        return NextResponse.json({ error: "Missing correctAnswer" }, { status: 400 });
      }

      attempts.push({
        conceptTag,
        question,
        selectedAnswer,
        correctAnswer,
        isCorrect: selectedAnswer !== null && selectedAnswer === correctAnswer,
      });
    }

    // Only completed quiz cycles reach this route:
    // - lesson_mastered: a lesson/remedial quiz has been cleared
    // - final_attempted: the final test has been submitted
    const lessonRunId = safeText(body.lessonRunId ?? null, 80) || null;

    const { error: insErr } = await supabase.from("question_attempts").insert(
      attempts.map((attempt) => ({
        user_id: userId,
        lesson_run_id: lessonRunId,
        concept_tag: attempt.conceptTag,
        question: attempt.question,
        selected_answer: attempt.selectedAnswer,
        correct_answer: attempt.correctAnswer,
        is_correct: attempt.isCorrect,
      }))
    );

    if (insErr) {
      console.error("attempt insert error:", insErr.message);
      return NextResponse.json({ error: "Failed to log attempt" }, { status: 500 });
    }

    const masteryResults = [];

    for (const attempt of attempts) {
      const normalizedConcept = normalizeConcept(attempt.conceptTag);

      const { data: normalizedRow, error: normalizedReadErr } = await supabase
        .from("concept_mastery")
        .select("concept_tag, normalized_concept, correct_count, wrong_count, streak")
        .eq("user_id", userId)
        .eq("normalized_concept", normalizedConcept)
        .maybeSingle();

      if (normalizedReadErr) {
        console.error("mastery read error:", normalizedReadErr.message);
        return NextResponse.json({ error: "Failed mastery read" }, { status: 500 });
      }

      let existingConceptTag = normalizedRow?.concept_tag ?? attempt.conceptTag;
      let prevCorrect = Number(normalizedRow?.correct_count ?? 0);
      let prevWrong = Number(normalizedRow?.wrong_count ?? 0);
      let prevStreak = Number(normalizedRow?.streak ?? 0);

      if (!normalizedRow) {
        const { data: rawRow, error: rawReadErr } = await supabase
          .from("concept_mastery")
          .select("concept_tag, normalized_concept, correct_count, wrong_count, streak")
          .eq("user_id", userId)
          .eq("concept_tag", attempt.conceptTag)
          .maybeSingle();

        if (rawReadErr) {
          console.error("mastery read error:", rawReadErr.message);
          return NextResponse.json({ error: "Failed mastery read" }, { status: 500 });
        }

        if (rawRow) {
          existingConceptTag = rawRow.concept_tag;
          prevCorrect = Number(rawRow.correct_count ?? 0);
          prevWrong = Number(rawRow.wrong_count ?? 0);
          prevStreak = Number(rawRow.streak ?? 0);
        }
      }

      const nextCorrect = prevCorrect + (attempt.isCorrect ? 1 : 0);
      const nextWrong = prevWrong + (attempt.isCorrect ? 0 : 1);
      const nextStreak = attempt.isCorrect ? prevStreak + 1 : 0;
      const nextReview = computeNextReview(nextStreak, attempt.isCorrect);
      const lastSeen = new Date();

      const { error: upErr } = await supabase.from("concept_mastery").upsert(
        {
          user_id: userId,
          concept_tag: existingConceptTag,
          normalized_concept: normalizedConcept,
          correct_count: nextCorrect,
          wrong_count: nextWrong,
          streak: nextStreak,
          last_seen: lastSeen.toISOString(),
          next_review: nextReview.toISOString(),
        },
        { onConflict: "user_id,concept_tag" }
      );

      if (upErr) {
        console.error("mastery upsert error:", upErr.message);
        return NextResponse.json({ error: "Failed mastery update" }, { status: 500 });
      }

      masteryResults.push({
        conceptTag: attempt.conceptTag,
        isCorrect: attempt.isCorrect,
        correctCount: nextCorrect,
        wrongCount: nextWrong,
        streak: nextStreak,
        nextReview: nextReview.toISOString(),
      });
    }

    return NextResponse.json({
      success: true,
      source: body.source,
      mastery: masteryResults,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("attempt route error:", msg);
    return NextResponse.json({ error: "Failed to log attempt: " + msg }, { status: 500 });
  }
}
