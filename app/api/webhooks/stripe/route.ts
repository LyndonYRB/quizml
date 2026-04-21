import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");

export async function POST(req: NextRequest) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("Missing STRIPE_WEBHOOK_SECRET");
    return NextResponse.json(
      { error: "Webhook secret is not configured" },
      { status: 500 }
    );
  }

  const signature = req.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json(
      { error: "Missing Stripe signature" },
      { status: 400 }
    );
  }

  let event: Stripe.Event;

  try {
    const rawBody = await req.text();
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Stripe webhook signature verification failed:", message);
    return NextResponse.json(
      { error: "Invalid Stripe webhook signature" },
      { status: 400 }
    );
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;

    console.log("Stripe checkout.session.completed:", {
      eventId: event.id,
      sessionId: session.id,
      customerId: session.customer,
      subscriptionId: session.subscription,
      paymentStatus: session.payment_status,
      metadata: session.metadata,
    });
  } else {
    console.log("Stripe webhook received:", {
      eventId: event.id,
      type: event.type,
    });
  }

  return NextResponse.json({ received: true });
}
