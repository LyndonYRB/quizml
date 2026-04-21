# QuizML.ai

QuizML.ai is a Next.js study app that turns uploaded PDFs into forced-mastery
micro-lessons. Authenticated users upload a PDF, choose a focus topic, and get:

- 5 generated micro-lessons
- 3 quiz questions per lesson
- a fixed 10-question final mastery test
- attempt logging by concept tag
- simple spaced-review scheduling
- Free and QuizML Pro usage limits through Stripe-backed profile fields

## Tech Stack

- Next.js App Router
- React
- Supabase Auth and Postgres
- OpenAI
- Stripe Checkout and webhooks
- Stripe Billing Portal
- Tailwind CSS

## Required Environment Variables

Create `.env.local` with:

```bash
OPENAI_API_KEY=

NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_MONTHLY=
STRIPE_PRICE_YEARLY=

NEXT_PUBLIC_APP_URL=http://localhost:3000
```

Notes:

- `SUPABASE_SERVICE_ROLE_KEY` is used only by trusted billing routes and webhooks to update billing entitlements.
- `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are required by browser and route clients.
- Use Stripe test keys locally unless intentionally testing against live Stripe resources.
- Set `NEXT_PUBLIC_APP_URL` to the deployed app origin in production.

## Supabase Setup

1. Create a Supabase project.
2. In Supabase SQL Editor, run:

```sql
-- paste and run the full contents of supabase/schema.sql
```

The schema file creates:

- `profiles`
- `daily_usage`
- `lesson_runs`
- `concept_mastery` (with raw and normalized concept tracking)
- `question_attempts`
- `question_reports`
- `increment_daily_generation(...)`
- required indexes
- RLS policies
- basic grants
- a trigger that creates a free `profiles` row for new Supabase Auth users

No Supabase Storage bucket is required by the current app.

## Persistence Notes

Generated mastery runs are stored in `lesson_runs.lessons_json` as a versioned
JSON payload:

```json
{
  "schemaVersion": 2,
  "lessons": [],
  "finalTest": [],
  "progress": null
}
```

The restore path requires exactly 5 lessons, exactly 3 quiz questions per
lesson, and exactly 10 final test questions. Older `lessons_json` rows that only
stored a lessons array are intentionally treated as incompatible and should be
regenerated.

## Free vs QuizML Pro Behavior

The app reads `profiles.is_paid` and `profiles.plan`:

- Free users get 5 generations per UTC day and a 10MB PDF limit.
- QuizML Pro users get an effectively unlimited generation limit and a 50MB PDF limit.
- Stripe webhooks update `profiles.plan`, `profiles.is_paid`,
  `profiles.stripe_customer_id`, `profiles.stripe_subscription_id`, and
  `profiles.subscription_status`, and `profiles.current_period_end`.
- QuizML Pro users can open Stripe Billing Portal to cancel, update payment
  method, and view billing history.

The daily generation counter is enforced by the
`increment_daily_generation(p_user_id, p_day, p_limit)` RPC.

## Auth Setup

Supabase email/password auth works with the app as-is after env vars are set.
For Google sign-in, configure a Google OAuth provider in the Supabase dashboard
and allow the callback URL:

```text
http://localhost:3000/auth/callback
```

For deployed environments, add the deployed `/auth/callback` URL too.

## Stripe Setup

Manual Stripe dashboard setup is still required:

- Create monthly and yearly subscription prices.
- Put their price IDs in `STRIPE_PRICE_MONTHLY` and `STRIPE_PRICE_YEARLY`.
- Enable Stripe Billing Portal settings for subscription cancellation, payment
  method updates, and invoice history.
- Configure a webhook endpoint for `/api/stripe/webhook`.
- Put the webhook signing secret in `STRIPE_WEBHOOK_SECRET`.

The checkout route sends `user_id` and `plan` in Stripe Checkout metadata so the
webhook can map the subscription back to the Supabase user profile.

## Run Locally

Install dependencies:

```bash
npm install
```

Start the dev server:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

Run checks:

```bash
npm run lint
npm run build
```

## Known Limitations

- There is no full lesson-run history picker yet; active restore currently uses
  the active lesson run id stored in the URL/localStorage.
- Existing old-format lesson runs where `lessons_json` is only an array will not
  restore and should be regenerated.
- The app has a simple review queue UI, not a full adaptive spaced-repetition
  review mode.
