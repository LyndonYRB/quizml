// app/api/lesson-run/[id]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createRouteClient } from "@/lib/supabase/server";

const LESSON_RUN_SCHEMA_VERSION = 2;

type PersistedQuestion = {
  question?: unknown;
  options?: unknown;
  correctAnswer?: unknown;
  hint?: unknown;
  explanation?: unknown;
  conceptTag?: unknown;
};

type PersistedLesson = {
  title?: unknown;
  whatItIs?: unknown;
  keyPoints?: unknown;
  examKeywords?: unknown;
  commonTraps?: unknown;
  quiz?: PersistedQuestion[];
};

type PersistedLessonRun = {
  schemaVersion?: unknown;
  lessons?: PersistedLesson[];
  finalTest?: PersistedQuestion[];
  progress?: unknown;
};

const VALID_PHASES = new Set([
  "lesson",
  "quiz",
  "remedialLesson",
  "remedialQuiz",
  "final",
  "finalRemedialLesson",
  "finalRemedialQuiz",
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPersistedQuestion(
  question: PersistedQuestion,
  options: { requireHint?: boolean; forbidHint?: boolean } = {}
) {
  const hasValidAnswer =
    typeof question.correctAnswer === "number" ||
    isNonEmptyString(question.correctAnswer);
  const hasHint = Object.prototype.hasOwnProperty.call(question, "hint");

  return (
    isNonEmptyString(question.question) &&
    Array.isArray(question.options) &&
    question.options.length === 4 &&
    question.options.every(isNonEmptyString) &&
    hasValidAnswer &&
    isNonEmptyString(question.explanation) &&
    isNonEmptyString(question.conceptTag) &&
    (!options.requireHint || isNonEmptyString(question.hint)) &&
    (!options.forbidHint || !hasHint)
  );
}

function isPersistedLesson(lesson: PersistedLesson) {
  return (
    isNonEmptyString(lesson.title) &&
    isNonEmptyString(lesson.whatItIs) &&
    Array.isArray(lesson.keyPoints) &&
    lesson.keyPoints.length > 0 &&
    lesson.keyPoints.every(isNonEmptyString) &&
    Array.isArray(lesson.examKeywords) &&
    lesson.examKeywords.length > 0 &&
    lesson.examKeywords.every(isNonEmptyString) &&
    Array.isArray(lesson.commonTraps) &&
    lesson.commonTraps.length > 0 &&
    lesson.commonTraps.every(isNonEmptyString) &&
    Array.isArray(lesson.quiz) &&
    lesson.quiz.length === 3 &&
    lesson.quiz.every((question) =>
      isPersistedQuestion(question, { requireHint: true })
    )
  );
}

function isValidPersistedLessonRun(
  value: unknown
): value is PersistedLessonRun & {
  lessons: PersistedLesson[];
  finalTest: PersistedQuestion[];
} {
  if (!value || typeof value !== "object") return false;

  const data = value as PersistedLessonRun;

  return (
    data.schemaVersion === LESSON_RUN_SCHEMA_VERSION &&
    Array.isArray(data.lessons) &&
    data.lessons.length === 5 &&
    data.lessons.every(isPersistedLesson) &&
    Array.isArray(data.finalTest) &&
    data.finalTest.length === 10 &&
    data.finalTest.every((question) =>
      isPersistedQuestion(question, { forbidHint: true })
    )
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sanitizeAnswerMap(value: unknown) {
  if (!isPlainObject(value)) return {};

  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 3) {
      result[key] = raw;
    }
  }
  return result;
}

function sanitizeQuestionArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((question) => isPlainObject(question)).slice(0, 10);
}

function sanitizeProgress(value: unknown) {
  if (!isPlainObject(value)) return null;

  const phase = typeof value.phase === "string" && VALID_PHASES.has(value.phase)
    ? value.phase
    : "lesson";
  const currentLessonIndex =
    typeof value.currentLessonIndex === "number" &&
    Number.isInteger(value.currentLessonIndex) &&
    value.currentLessonIndex >= 0 &&
    value.currentLessonIndex <= 4
      ? value.currentLessonIndex
      : 0;

  return {
    phase,
    currentLessonIndex,
    completedLessonIndexes: Array.isArray(value.completedLessonIndexes)
      ? value.completedLessonIndexes
          .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx <= 4)
          .slice(0, 5)
      : [],
    selectedAnswers: sanitizeAnswerMap(value.selectedAnswers),
    showResults: Boolean(value.showResults),
    missedQuestions: sanitizeQuestionArray(value.missedQuestions),
    finalAnswers: sanitizeAnswerMap(value.finalAnswers),
    showFinalResults: Boolean(value.showFinalResults),
    finalMissedQuestions: sanitizeQuestionArray(value.finalMissedQuestions),
  };
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const response = NextResponse.next();

  try {
    const { id } = await context.params;

    if (!id) {
      return NextResponse.json({ error: "Missing lesson run id." }, { status: 400 });
    }

    const supabase = createRouteClient(request, response);
    const { data: userData, error: userErr } = await supabase.auth.getUser();

    if (userErr || !userData?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: runRow, error: runErr } = await supabase
      .from("lesson_runs")
      .select("id, lessons_json")
      .eq("id", id)
      .eq("user_id", userData.user.id)
      .maybeSingle();

    if (runErr) {
      console.error("lesson_runs restore error:", runErr.message);
      return NextResponse.json(
        { error: "Failed to load lesson run." },
        { status: 500 }
      );
    }

    if (!runRow) {
      return NextResponse.json({ error: "Lesson run not found." }, { status: 404 });
    }

    if (!isValidPersistedLessonRun(runRow.lessons_json)) {
      return NextResponse.json(
        { error: "Saved lesson run is incomplete or incompatible." },
        { status: 409 }
      );
    }

    return NextResponse.json({
      success: true,
      lessonRunId: runRow.id,
      schemaVersion: runRow.lessons_json.schemaVersion,
      lessons: runRow.lessons_json.lessons,
      finalTest: runRow.lessons_json.finalTest,
      progress: sanitizeProgress(runRow.lessons_json.progress),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("lesson run restore route error:", msg);
    return NextResponse.json(
      { error: "Failed to load lesson run: " + msg },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const response = NextResponse.next();

  try {
    const { id } = await context.params;

    if (!id) {
      return NextResponse.json({ error: "Missing lesson run id." }, { status: 400 });
    }

    const body = (await request.json().catch(() => null)) as {
      progress?: unknown;
    } | null;
    const progress = sanitizeProgress(body?.progress);

    if (!progress) {
      return NextResponse.json({ error: "Missing valid progress." }, { status: 400 });
    }

    const supabase = createRouteClient(request, response);
    const { data: userData, error: userErr } = await supabase.auth.getUser();

    if (userErr || !userData?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: runRow, error: readErr } = await supabase
      .from("lesson_runs")
      .select("lessons_json")
      .eq("id", id)
      .eq("user_id", userData.user.id)
      .maybeSingle();

    if (readErr) {
      console.error("lesson_runs progress read error:", readErr.message);
      return NextResponse.json(
        { error: "Failed to load lesson run." },
        { status: 500 }
      );
    }

    if (!runRow || !isValidPersistedLessonRun(runRow.lessons_json)) {
      return NextResponse.json({ error: "Lesson run not found." }, { status: 404 });
    }

    const { error: updateErr } = await supabase
      .from("lesson_runs")
      .update({
        lessons_json: {
          ...runRow.lessons_json,
          progress,
        },
      })
      .eq("id", id)
      .eq("user_id", userData.user.id);

    if (updateErr) {
      console.error("lesson_runs progress update error:", updateErr.message);
      return NextResponse.json(
        { error: "Failed to save lesson progress." },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, progress });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("lesson run progress route error:", msg);
    return NextResponse.json(
      { error: "Failed to save lesson progress: " + msg },
      { status: 500 }
    );
  }
}
