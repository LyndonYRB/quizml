// app/api/stripe/webhook/route.ts
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

/* =========================================================
   CONFIG
========================================================= */

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";

// Service role client (bypasses RLS)
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

/* =========================================================
   HELPERS
========================================================= */

function planFromPriceId(priceId?: string | null): "monthly" | "yearly" | "free" {
  if (!priceId) return "free";
  if (priceId === process.env.STRIPE_PRICE_MONTHLY) return "monthly";
  if (priceId === process.env.STRIPE_PRICE_YEARLY) return "yearly";
  return "free";
}

async function upsertEntitlement(params: {
  userId: string;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  plan: "free" | "monthly" | "yearly";
  isPaid: boolean;
  subscriptionStatus?: string | null;
  currentPeriodEnd?: string | null; // ISO
}) {
  const {
    userId,
    stripeCustomerId,
    stripeSubscriptionId,
    plan,
    isPaid,
    subscriptionStatus,
    currentPeriodEnd,
  } = params;

  const { error } = await supabaseAdmin
    .from("profiles")
    .upsert(
      {
        user_id: userId,
        plan,
        is_paid: isPaid,
        stripe_customer_id: stripeCustomerId ?? null,
        stripe_subscription_id: stripeSubscriptionId ?? null,
        subscription_status: subscriptionStatus ?? null,
        current_period_end: currentPeriodEnd
          ? new Date(currentPeriodEnd).toISOString()
          : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );

  if (error) throw new Error("profiles upsert failed: " + error.message);
}

async function findUserIdFromCustomer(customerId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("user_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();

  if (error) throw new Error("profiles lookup failed: " + error.message);
  if (data?.user_id) return data.user_id;

  const customer = await stripe.customers.retrieve(customerId);
  if (!customer.deleted && typeof customer.metadata?.user_id === "string") {
    return customer.metadata.user_id;
  }

  return null;
}

function periodEndFromSubscription(sub: Stripe.Subscription) {
  const subscriptionPeriod = sub as Stripe.Subscription & {
    current_period_end?: number | null;
  };
  const itemPeriod = sub.items.data?.[0] as
    | (Stripe.SubscriptionItem & { current_period_end?: number | null })
    | undefined;
  const timestamp =
    subscriptionPeriod.current_period_end ?? itemPeriod?.current_period_end ?? null;

  return timestamp ? new Date(timestamp * 1000).toISOString() : null;
}

function paidFromSubscriptionStatus(status: Stripe.Subscription.Status) {
  return status === "active" || status === "trialing";
}

async function syncSubscriptionEntitlement(sub: Stripe.Subscription) {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const userId = await findUserIdFromCustomer(customerId);

  if (!userId) return;

  const firstItem = sub.items.data?.[0];
  const priceId = firstItem?.price?.id ?? null;
  const plan = planFromPriceId(priceId);
  const isPaid = paidFromSubscriptionStatus(sub.status) && plan !== "free";

  await upsertEntitlement({
    userId,
    stripeCustomerId: customerId,
    stripeSubscriptionId: sub.id,
    plan: isPaid ? plan : "free",
    isPaid,
    subscriptionStatus: sub.status,
    currentPeriodEnd: periodEndFromSubscription(sub),
  });
}

/* =========================================================
   ROUTE: POST /api/stripe/webhook
========================================================= */

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const sig = req.headers.get("stripe-signature");

    if (!sig) return NextResponse.json({ error: "Missing signature" }, { status: 400 });

    const event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);

    /* ---------------------------------------------------------
       EVENT HANDLING
    --------------------------------------------------------- */

    // 1) Checkout completed -> attach customer/subscription + set paid
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      const userId = (session.metadata?.user_id as string) || null;
      const plan = (session.metadata?.plan as "monthly" | "yearly") || "monthly";

      if (!userId) {
        console.warn("checkout.session.completed missing user_id metadata");
        return NextResponse.json({ received: true });
      }

      const subscriptionId =
        typeof session.subscription === "string" ? session.subscription : null;
      const customerId = typeof session.customer === "string" ? session.customer : null;

      if (subscriptionId) {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        await syncSubscriptionEntitlement(subscription);
        return NextResponse.json({ received: true });
      }

      await upsertEntitlement({
        userId,
        stripeCustomerId: customerId,
        stripeSubscriptionId: null,
        plan,
        isPaid: session.payment_status === "paid",
        subscriptionStatus: session.status,
        currentPeriodEnd: null,
      });

      return NextResponse.json({ received: true });
    }

    // 2) Subscription updated -> maintain plan/is_paid and period end
    if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.created") {
      const sub = event.data.object as Stripe.Subscription;
      await syncSubscriptionEntitlement(sub);

      return NextResponse.json({ received: true });
    }

    // 3) Subscription deleted -> set free
    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object as Stripe.Subscription;

      const customerId = (sub.customer as string) || null;
      if (!customerId) return NextResponse.json({ received: true });

      const userId = await findUserIdFromCustomer(customerId);
      if (!userId) return NextResponse.json({ received: true });

      await upsertEntitlement({
        userId,
        stripeCustomerId: customerId,
        stripeSubscriptionId: sub.id,
        plan: "free",
        isPaid: false,
        subscriptionStatus: sub.status,
        currentPeriodEnd: null,
      });

      return NextResponse.json({ received: true });
    }

    // 4) Payment failed -> remove paid access until Stripe reports active again.
    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object as Stripe.Invoice & {
        customer?: string | Stripe.Customer | Stripe.DeletedCustomer | null;
        subscription?: string | Stripe.Subscription | null;
      };
      const customerId =
        typeof invoice.customer === "string"
          ? invoice.customer
          : invoice.customer && !invoice.customer.deleted
          ? invoice.customer.id
          : null;

      if (!customerId) return NextResponse.json({ received: true });

      const userId = await findUserIdFromCustomer(customerId);
      if (!userId) return NextResponse.json({ received: true });

      const subscriptionId =
        typeof invoice.subscription === "string"
          ? invoice.subscription
          : invoice.subscription?.id ?? null;

      await upsertEntitlement({
        userId,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        plan: "free",
        isPaid: false,
        subscriptionStatus: "past_due",
        currentPeriodEnd: null,
      });

      return NextResponse.json({ received: true });
    }

    return NextResponse.json({ received: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("stripe webhook error:", msg);
    return NextResponse.json({ error: "Webhook error: " + msg }, { status: 400 });
  }
}
