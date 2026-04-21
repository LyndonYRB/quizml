// app/components/PricingButtons.tsx

"use client";

type Props = {
  isAuthed: boolean;
  isPaid: boolean;
  planName?: string;
  subscriptionStatus?: string | null;
  onOpenAuth?: () => void;
};

export default function PricingButtons({
  isAuthed,
  isPaid,
  planName,
  subscriptionStatus,
  onOpenAuth,
}: Props) {
  const canManageBilling =
    isPaid ||
    subscriptionStatus === "past_due" ||
    subscriptionStatus === "unpaid";

  async function startCheckout(plan: "monthly" | "yearly") {
    if (!isAuthed) {
      onOpenAuth?.();
      return;
    }

    const res = await fetch("/api/stripe/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      alert(data?.error || "Checkout failed");
      return;
    }

    window.location.href = data.url;
  }

  async function openBillingPortal() {
    if (!isAuthed) {
      onOpenAuth?.();
      return;
    }

    const res = await fetch("/api/stripe/portal", { method: "POST" });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      alert(data?.error || "Billing portal failed");
      return;
    }

    window.location.href = data.url;
  }

  return (
    <div className="mt-4 rounded-lg border border-white/10 bg-white/5 p-4">
      <h3 className="text-base font-bold text-white">
        {isPaid
          ? "QuizML Pro active"
          : canManageBilling
          ? "Payment needs attention"
          : "Upgrade"}
      </h3>
      <p className="mt-1 text-sm text-white/70">
        {isPaid
          ? `QuizML Pro ${
              planName === "yearly" ? "Yearly" : "Monthly"
            } active${
              subscriptionStatus ? ` (${subscriptionStatus})` : ""
            }. Unlimited generations and the higher PDF upload limit.`
          : canManageBilling
          ? "Update your payment method to restore QuizML Pro access."
          : "Unlimited generations and a higher PDF upload limit."}
      </p>

      {canManageBilling ? (
        <button
          onClick={openBillingPortal}
          className="mt-3 w-full rounded-lg bg-blue-500 px-4 py-2.5 font-semibold text-white transition hover:bg-blue-600"
        >
          Manage Subscription
        </button>
      ) : (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <button
            onClick={() => startCheckout("monthly")}
            className="rounded-lg bg-blue-500 px-4 py-2.5 font-semibold text-white hover:bg-blue-600 transition"
          >
            $10 / month
          </button>

          <button
            onClick={() => startCheckout("yearly")}
            className="rounded-lg bg-purple-500 px-4 py-2.5 font-semibold text-white hover:bg-purple-600 transition"
          >
            $72 / year (40% off)
          </button>
        </div>
      )}

      {!isAuthed && !isPaid && (
        <p className="mt-2 text-xs text-white/50">
          You will be asked to sign in first.
        </p>
      )}
    </div>
  );
}
