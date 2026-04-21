import { NextRequest, NextResponse } from "next/server";
import { createRouteClient } from "@/lib/supabase/server";

type QuestionReportPayload = {
  lessonRunId?: string | null;
  questionKey: string;
  questionSource: string;
  questionText: string;
  selectedAnswer?: number | null;
  correctAnswer?: number | null;
  reason: string;
  note?: string | null;
};

function safeText(x: unknown, max = 2000) {
  const s = typeof x === "string" ? x : "";
  return s.replace(/[^\S\r\n\t\u0020-\uFFFF]/g, "").slice(0, max).trim();
}

function safeInt(x: unknown) {
  if (typeof x === "number" && Number.isFinite(x)) return Math.trunc(x);
  if (typeof x === "string" && x.trim() !== "" && !Number.isNaN(Number(x)))
    return Math.trunc(Number(x));
  return null;
}

export async function POST(req: NextRequest) {
  const res = NextResponse.next();

  try {
    const supabase = createRouteClient(req, res);
    const { data: userData, error: userErr } = await supabase.auth.getUser();

    if (userErr || !userData?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as QuestionReportPayload | null;

    if (!body) {
      return NextResponse.json({ error: "Missing JSON body" }, { status: 400 });
    }

    const questionKey = safeText(body.questionKey, 400);
    const questionSource = safeText(body.questionSource, 120);
    const questionText = safeText(body.questionText, 2000);
    const selectedAnswer = body.selectedAnswer === undefined ? null : safeInt(body.selectedAnswer);
    const correctAnswer = body.correctAnswer === undefined ? null : safeInt(body.correctAnswer);
    const reason = safeText(body.reason, 120);
    const note = safeText(body.note ?? "", 2000) || null;
    const lessonRunId = safeText(body.lessonRunId ?? null, 80) || null;

    if (!questionKey) {
      return NextResponse.json({ error: "Missing questionKey" }, { status: 400 });
    }
    if (!questionSource) {
      return NextResponse.json({ error: "Missing questionSource" }, { status: 400 });
    }
    if (!questionText) {
      return NextResponse.json({ error: "Missing questionText" }, { status: 400 });
    }
    if (!reason) {
      return NextResponse.json({ error: "Missing reason" }, { status: 400 });
    }

    const { error: insErr } = await supabase.from("question_reports").insert({
      user_id: userData.user.id,
      lesson_run_id: lessonRunId,
      question_key: questionKey,
      question_source: questionSource,
      question_text: questionText,
      selected_answer: selectedAnswer,
      correct_answer: correctAnswer,
      reason,
      note,
    });

    if (insErr) {
      console.error("question_report insert error:", {
        message: insErr.message,
        details: insErr.details,
        hint: insErr.hint,
        code: insErr.code,
        payload: {
          userId: userData.user.id,
          lessonRunId,
          questionKey,
          questionSource,
          reason,
        },
      });
      return NextResponse.json({ error: "Failed to save report" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("question-report route error:", message);
    return NextResponse.json({ error: "Failed to submit report: " + message }, { status: 500 });
  }
}
