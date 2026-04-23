// app/api/stripe/checkout/route.ts
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createRouteClient } from "@/lib/supabase/server";
import { createClient } from "@supabase/supabase-js";

/* =========================================================
   CONFIG
========================================================= */

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

type ProfileRow = {
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  is_paid?: boolean | null;
};

function getAppUrl() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;

  if (appUrl) return appUrl;
  if (process.env.NODE_ENV !== "production") return "http://localhost:3000";

  throw new Error(
    "Missing NEXT_PUBLIC_APP_URL in production. Stripe checkout requires an absolute app URL."
  );
}

/* =========================================================
   ROUTE: POST /api/stripe/checkout
   Body: { plan: "monthly" | "yearly" }
========================================================= */

export async function POST(req: NextRequest) {
  const res = NextResponse.next();

  try {
    const appUrl = getAppUrl();

    /* ---------------------------------------------------------
       1) AUTH (Required)
    --------------------------------------------------------- */

    const supabase = createRouteClient(req, res);
    const { data: userData, error: userErr } = await supabase.auth.getUser();

    if (userErr || !userData?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = userData.user.id;
    const email = userData.user.email || undefined;

    /* ---------------------------------------------------------
       2) INPUT
    --------------------------------------------------------- */

    const body = await req.json().catch(() => ({}));
    const plan = body?.plan;

    const priceId =
      plan === "monthly"
        ? process.env.STRIPE_PRICE_MONTHLY
        : plan === "yearly"
        ? process.env.STRIPE_PRICE_YEARLY
        : null;

    if (!priceId) {
      return NextResponse.json({ error: "Invalid plan." }, { status: 400 });
    }

    /* ---------------------------------------------------------
       3) ENSURE ONE STRIPE CUSTOMER PER USER
    --------------------------------------------------------- */

    const { data: profile, error: profileErr } = await supabaseAdmin
      .from("profiles")
      .select("stripe_customer_id, stripe_subscription_id, is_paid")
      .eq("user_id", userId)
      .maybeSingle<ProfileRow>();

    if (profileErr) {
      console.error("profile checkout lookup error:", profileErr.message);
      return NextResponse.json(
        { error: "Could not load billing profile." },
        { status: 500 }
      );
    }

    if (profile?.is_paid && profile.stripe_customer_id) {
      return NextResponse.json(
        { error: "Subscription is already active. Manage it from billing settings." },
        { status: 409 }
      );
    }

    let customerId = profile?.stripe_customer_id ?? null;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: {
          user_id: userId,
        },
      });
      customerId = customer.id;

      const { error: upsertErr } = await supabaseAdmin.from("profiles").upsert(
        {
          user_id: userId,
          stripe_customer_id: customerId,
          is_paid: false,
          plan: "free",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );

      if (upsertErr) {
        console.error("profile customer upsert error:", upsertErr.message);
        return NextResponse.json(
          { error: "Could not save billing profile." },
          { status: 500 }
        );
      }
    }

    /* ---------------------------------------------------------
       4) CREATE CHECKOUT SESSION
       - customer reuses the canonical Stripe Customer
       - metadata lets webhooks repair profile mapping if needed
    --------------------------------------------------------- */

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}/?billing=success`,
      cancel_url: `${appUrl}/?billing=cancel`,
      subscription_data: {
        metadata: {
          user_id: userId,
          plan,
        },
      },
      metadata: {
        user_id: userId,
        plan,
      },
    });

    return NextResponse.json({ success: true, url: session.url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("stripe checkout error:", msg);
    return NextResponse.json({ error: "Checkout failed: " + msg }, { status: 500 });
  }
}
