// app/api/review-due/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createRouteClient } from "@/lib/supabase/server";
import { normalizeConcept } from "@/lib/concepts";

/* =========================================================
   CONFIG
========================================================= */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/* =========================================================
   HELPERS
========================================================= */

function safeLimit(input: string | null | undefined) {
  const n = Number(input);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_LIMIT);
}

function nowISO() {
  return new Date().toISOString();
}

/* =========================================================
   ROUTE: GET /api/review-due
========================================================= */

export async function GET(req: NextRequest) {
  // response is used for cookie handling in createRouteClient
  const res = NextResponse.next();

  try {
    /* ---------------------------------------------------------
       1) AUTHENTICATION (Required)
    --------------------------------------------------------- */

    const supabase = createRouteClient(req, res);
    const { data: userData, error: userErr } = await supabase.auth.getUser();

    if (userErr || !userData?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = userData.user.id;

    /* ---------------------------------------------------------
       2) INPUT PARSING (limit)
    --------------------------------------------------------- */

    const url = new URL(req.url);
    const limit = safeLimit(url.searchParams.get("limit"));
    const now = nowISO();

    /* ---------------------------------------------------------
       3) READ DUE REVIEWS (next_review <= now)
    --------------------------------------------------------- */

    const { data, error } = await supabase
      .from("concept_mastery")
      .select(
        "concept_tag, normalized_concept, correct_count, wrong_count, streak, last_seen, next_review"
      )
      .eq("user_id", userId)
      .not("next_review", "is", null)
      .or("correct_count.gt.0,wrong_count.gt.0")
      .lte("next_review", now)
      .order("next_review", { ascending: true })
      .limit(limit * 3);

    if (error) {
      console.error("review-due read error:", error.message);
      return NextResponse.json(
        { error: "Failed to load review due." },
        { status: 500 }
      );
    }

    const grouped = new Map<string, {
      concept_tag: string;
      normalized_concept: string;
      correct_count: number;
      wrong_count: number;
      streak: number;
      last_seen: string;
      next_review: string;
    }>();

    for (const row of (data ?? [])) {
      const rawConcept = String(row.concept_tag ?? "");
      const normalizedConcept = String(
        row.normalized_concept ?? normalizeConcept(rawConcept)
      );
      if (!normalizedConcept) continue;

      const currentNextReview = String(row.next_review ?? "");
      const existing = grouped.get(normalizedConcept);

      if (!existing || currentNextReview < existing.next_review) {
        grouped.set(normalizedConcept, {
          concept_tag: rawConcept,
          normalized_concept: normalizedConcept,
          correct_count: Number(row.correct_count ?? 0),
          wrong_count: Number(row.wrong_count ?? 0),
          streak: Number(row.streak ?? 0),
          last_seen: String(row.last_seen ?? ""),
          next_review: currentNextReview,
        });
      }
    }

    const due = Array.from(grouped.values()).slice(0, limit);

    /* ---------------------------------------------------------
       4) RESPONSE
    --------------------------------------------------------- */

    return NextResponse.json({
      success: true,
      now,
      due,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("review-due route error:", msg);
    return NextResponse.json(
      { error: "Failed to load review due: " + msg },
      { status: 500 }
    );
  }
}
