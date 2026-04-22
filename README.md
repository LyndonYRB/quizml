# QuizML.ai

QuizML.ai is a production-oriented SaaS study app that turns PDFs into
AI-generated micro-lessons, quizzes, mastery checks, and review signals. The app
uses a retrieval-augmented generation pipeline so lesson generation is grounded
in selected saved study materials, not raw one-shot PDF prompts.

## Portfolio Summary

QuizML combines document ingestion, vector search, reranking, subscription
billing, and lesson persistence in a full-stack Next.js product. Users upload
study PDFs, choose saved materials, enter a focus topic, and receive a strict
five-lesson learning path with quizzes and a final mastery test. The backend
stores document chunks in Supabase, embeds them with OpenAI, retrieves relevant
chunks with pgvector, falls back to keyword retrieval when needed, reranks
candidate chunks with an LLM, and stores traceable lesson runs.

## Tech Stack

- Next.js App Router
- React
- Supabase Auth and Postgres
- Supabase Row Level Security
- pgvector
- OpenAI chat completions and embeddings
- Stripe Checkout, webhooks, and Billing Portal
- Vercel
- Tailwind CSS

## Architecture Overview

The core pipeline is retrieval based:

1. User uploads one or more PDFs.
2. The ingestion route extracts text.
3. Text is normalized and split into deterministic chunks.
4. Chunks are stored in `study_material_chunks`.
5. OpenAI embeddings are generated per chunk and stored in pgvector.
6. User selects saved study materials and enters a focus topic.
7. Generation retrieves candidate chunks with vector search.
8. If vector search fails or has no matches, keyword retrieval is used.
9. Candidate chunks are reranked with `gpt-4o-mini`.
10. Lessons are generated only from the final reranked chunk subset.
11. Lesson runs, source materials, and used chunks are linked for traceability.

The lesson schema is intentionally strict:

- exactly 5 micro-lessons
- exactly 3 quiz questions per lesson
- exactly 10 final test questions

## Production Architecture

Important production behavior:

- Free users can use one study material at a time.
- Paid users can select multiple saved study materials.
- Upload limits are plan-aware: 10MB free, 50MB paid.
- Daily generation usage is enforced by the `increment_daily_generation` RPC.
- Stripe webhooks sync billing state into `profiles`.
- `lesson_run_materials` links a lesson run to source materials.
- `lesson_run_chunks` links a lesson run to the exact chunks used.
- OpenAI calls use bounded retries with exponential backoff and jitter.
- Embedding failures do not fail ingestion; chunks are stored with `embedding = null`.
- Vector retrieval falls back to keyword retrieval.
- Reranking falls back to deterministic candidate order when needed.

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

- `OPENAI_API_KEY` is required for embeddings, reranking, and lesson generation.
- `SUPABASE_SERVICE_ROLE_KEY` is used only by trusted billing routes and webhooks.
- `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are required by browser and route clients.
- `NEXT_PUBLIC_APP_URL` should be your deployed app origin in production.
- Use Stripe test keys locally unless intentionally testing live billing.

## Supabase Setup

For a new Supabase project, run the full schema:

```sql
-- paste and run supabase/schema.sql in the Supabase SQL editor
```

For an existing project, apply migrations in `supabase/migrations`.

The current schema uses:

- `profiles`
- `daily_usage`
- `study_materials`
- `study_material_chunks`
- `lesson_runs`
- `lesson_run_materials`
- `lesson_run_chunks`
- `concept_mastery`
- `question_attempts`
- `question_reports`
- `increment_daily_generation(...)`
- `match_study_material_chunks(...)`

The Supabase project must support pgvector:

```sql
create extension if not exists vector;
```

No Supabase Storage bucket is required by the current architecture. Material
URLs point back into the app so saved materials can be selected for generation.

## Stripe Setup

Manual Stripe dashboard setup is required:

- Create monthly and yearly subscription prices.
- Put price IDs in `STRIPE_PRICE_MONTHLY` and `STRIPE_PRICE_YEARLY`.
- Configure Stripe Billing Portal.
- Configure a webhook endpoint for `/api/stripe/webhook`.
- Put the webhook signing secret in `STRIPE_WEBHOOK_SECRET`.

Checkout metadata includes `user_id` and `plan`, allowing the webhook to map
subscriptions back to Supabase profiles.

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

## Deployment Notes

Vercel deployment requirements:

- Set all environment variables in Vercel project settings.
- Apply Supabase migrations before deploying features that depend on new tables or columns.
- Confirm the Stripe webhook URL points to the deployed `/api/stripe/webhook`.
- Watch Vercel runtime logs for ingestion, embedding, retrieval, rerank, and generation events.

The app is serverless-compatible. Long-running work is bounded by per-file size
limits, candidate chunk limits, final chunk limits, and small OpenAI retry caps.

## Resume Bullets

- Built a full-stack AI learning SaaS with Next.js App Router, Supabase, Stripe subscriptions, and Vercel deployment.
- Implemented a production RAG pipeline with PDF ingestion, chunk storage, OpenAI embeddings, pgvector retrieval, keyword fallback, LLM reranking, and traceable lesson runs.
- Designed strict AI output validation for generated micro-lessons, quizzes, final tests, concept tags, and persisted resume state.
- Integrated Stripe Checkout, webhooks, billing portal management, free/paid entitlements, and plan-aware feature limits.

## Known Limitations

- There is no full lesson-run history picker yet; restore currently uses the active lesson run id in URL/localStorage.
- Existing old-format lesson runs where `lessons_json` is only an array will not restore and should be regenerated.
- Review mode is intentionally simple and not yet a full adaptive spaced-repetition product.
