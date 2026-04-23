import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createRouteClient } from "@/lib/supabase/server";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");

type ProfileRow = {
  stripe_customer_id?: string | null;
  is_paid?: boolean | null;
};

function getAppUrl() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;

  if (appUrl) return appUrl;
  if (process.env.NODE_ENV !== "production") return "http://localhost:3000";

  throw new Error(
    "Missing NEXT_PUBLIC_APP_URL in production. Stripe billing portal requires an absolute app URL."
  );
}

export async function POST(req: NextRequest) {
  const res = NextResponse.next();

  try {
    const appUrl = getAppUrl();

    const supabase = createRouteClient(req, res);
    const { data: userData, error: userErr } = await supabase.auth.getUser();

    if (userErr || !userData?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: profile, error: profileErr } = await supabase
      .from("profiles")
      .select("stripe_customer_id, is_paid")
      .eq("user_id", userData.user.id)
      .maybeSingle<ProfileRow>();

    if (profileErr) {
      console.error("profile portal lookup error:", profileErr.message);
      return NextResponse.json(
        { error: "Could not load billing profile." },
        { status: 500 }
      );
    }

    if (!profile?.stripe_customer_id) {
      return NextResponse.json(
        { error: "No Stripe billing profile to manage." },
        { status: 400 }
      );
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${appUrl}/?billing=portal`,
    });

    return NextResponse.json({ success: true, url: session.url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("stripe portal error:", msg);
    return NextResponse.json({ error: "Billing portal failed: " + msg }, { status: 500 });
  }
}
