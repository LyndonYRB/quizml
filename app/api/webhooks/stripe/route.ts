// Legacy alias for the canonical Stripe webhook route.
// Production Stripe configuration should point only to /api/stripe/webhook.
export { POST } from "../../stripe/webhook/route";
