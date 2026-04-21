// app/api/usage/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createRouteClient } from "@/lib/supabase/server";

/* =========================================================
   CONFIG
========================================================= */

const DAILY_LIMIT_FREE = 5;
const DAILY_LIMIT_PAID = 9999; // effectively unlimited

/* =========================================================
   HELPERS
========================================================= */

function utcTodayISODate(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/* =========================================================
   ROUTE: GET /api/usage
========================================================= */

export async function GET(request: NextRequest) {
  const response = NextResponse.next();

  try {
    /* ---------------------------------------------------------
       1) AUTHENTICATION
    --------------------------------------------------------- */

    const supabase = createRouteClient(request, response);
    const { data: userData, error: userErr } = await supabase.auth.getUser();

    if (userErr || !userData?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = userData.user.id;
    const day = utcTodayISODate();

    /* ---------------------------------------------------------
       1.1) LOAD USER PLAN (free vs paid)
    --------------------------------------------------------- */

    const { data: profile } = await supabase
      .from("profiles")
      .select(
        "is_paid, plan, subscription_status, current_period_end, price_id, cancel_at_period_end"
      )
      .eq("user_id", userId)
      .maybeSingle();

    const isPaid = !!profile?.is_paid;
    const limit = isPaid ? DAILY_LIMIT_PAID : DAILY_LIMIT_FREE;

    /* ---------------------------------------------------------
       2) READ DAILY USAGE (no increment)
    --------------------------------------------------------- */

    const { data: usageRow, error: readErr } = await supabase
      .from("daily_usage")
      .select("generations")
      .eq("user_id", userId)
      .eq("day", day)
      .maybeSingle();

    if (readErr) {
      return NextResponse.json(
        { error: "Failed to read usage" },
        { status: 500 }
      );
    }

    const used = Number(usageRow?.generations ?? 0);
    const remaining = Math.max(0, limit - used);

    /* ---------------------------------------------------------
       3) RESPONSE
    --------------------------------------------------------- */

    return NextResponse.json({
      success: true,
      usage: {
        limit,
        used,
        remaining,
        day,
        isPaid,
        plan: profile?.plan ?? "free",
        subscriptionStatus: profile?.subscription_status ?? null,
        currentPeriodEnd: profile?.current_period_end ?? null,
        priceId: profile?.price_id ?? null,
        cancelAtPeriodEnd: profile?.cancel_at_period_end ?? false,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to load usage: " + msg },
      { status: 500 }
    );
  }
}
