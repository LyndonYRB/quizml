# QuizML

**AI-Powered Multi-Document Learning & Quiz System (RAG + Adaptive Remediation)**

QuizML is an AI-driven learning platform that transforms PDFs into structured micro-lessons, quizzes, and adaptive remediation using a multi-document Retrieval-Augmented Generation (RAG) pipeline.

Unlike basic AI summarizers, QuizML:

- cross-references multiple documents
- generates exam-style questions
- adapts learning based on user performance
- stores source chunks and lesson-run links for traceable generation

## Features

### Multi-File AI Learning

- Upload multiple PDFs such as Security+, PenTest+, class notes, or study guides.
- System cross-references selected saved materials.
- Supports cumulative uploads, so users do not need to re-upload PDFs for each new lesson run.
- Free users can work with one study material at a time.
- Paid users can generate from multiple saved study materials.

### Retrieval-Augmented Generation (RAG)

Text is:

```text
extracted -> chunked -> embedded -> stored -> retrieved -> reranked -> generated
```

The retrieval layer uses:

- Supabase Postgres with pgvector
- OpenAI embeddings
- vector search first
- keyword fallback when vectors are missing or unavailable
- LLM reranking before lesson generation

Lessons are generated from retrieved chunk subsets, not raw uploaded PDFs.

### Micro-Learning System

- Breaks material into digestible lessons.
- Uses focus-based prompts such as "network ports" or "SQL injection."
- Produces structured explanations, key points, exam keywords, and common traps.

### AI-Generated Quizzes

- Scenario-based questions.
- Exam-style distractors and trap answers.
- Explanations and hints tied to concept tags.

### Adaptive Remediation

- Missed questions feed concept-level review signals.
- Learners can revisit weak areas.
- Progress is persisted for lesson resume.

### Final Assessment

- Comprehensive final test across the generated lesson set.
- Strict schema: exactly 5 lessons, 3 quiz questions per lesson, and 10 final test questions.

### User Feedback System

- Users can report bad or incorrect questions.
- Reports are stored for future model and prompt refinement.

## Architecture

### Pipeline Overview

```text
PDF Upload
   ↓
Text Extraction (unpdf)
   ↓
Chunking
   ↓
Embeddings (OpenAI)
   ↓
Supabase Postgres + pgvector
   ↓
Vector Retrieval
   ↓
Keyword Fallback
   ↓
LLM Reranking
   ↓
Lesson Generation
   ↓
Quiz + Remediation Loop
```

### Data Flow

1. User uploads one or more PDFs.
2. `/api/ingest-materials` extracts text with `unpdf`.
3. Extracted text is normalized and split into deterministic chunks.
4. Chunks are inserted into `study_material_chunks`.
5. Embeddings are generated with OpenAI and stored when available.
6. Embedding failures do not block ingestion; chunks remain usable through keyword fallback.
7. User selects saved study materials and enters a focus topic.
8. `/api/generate-lessons` retrieves relevant chunks using pgvector.
9. If vector retrieval fails, keyword retrieval is used.
10. Candidate chunks are reranked with a lightweight LLM step.
11. Lesson generation uses only the final retrieved and reranked chunk subset.
12. `lesson_run_materials` and `lesson_run_chunks` store source traceability.

## Tech Stack

### Frontend

- Next.js App Router
- React
- Tailwind CSS

### Backend

- Next.js API routes on Vercel
- Supabase Auth
- Supabase Postgres
- Supabase Row Level Security
- pgvector
- OpenAI API for embeddings, reranking, and lesson generation

### Infrastructure

- Vercel deployment
- Supabase database and auth
- Stripe Checkout, webhooks, and Billing Portal

## Monetization Model

### Free Tier

- One PDF per ingest action.
- One saved study material per generation.
- Daily generation limit.
- 10MB PDF upload limit.

### Paid Tier

- Multi-file ingestion.
- Multi-document lesson generation.
- Higher upload limits.
- Expanded usage through Stripe-backed subscription state.

## Key Engineering Challenges Solved

### Multi-File Ingestion Pipeline

- Handles batch uploads safely.
- Continues processing other files if one file fails.
- Returns partial success only for materials with verified chunk persistence.
- Cleans up failed material inserts when chunk persistence fails.

### Vector Database Integration

- Stores OpenAI embeddings in Supabase pgvector.
- Uses HNSW indexing for vector search.
- Keeps keyword fallback for chunks without embeddings.
- Avoids sending invalid vector payloads to Postgres.

### Rate Limiting & Reliability

- Sequential chunk embedding avoids overwhelming OpenAI rate limits.
- OpenAI calls use bounded retry behavior where appropriate.
- Failed embeddings do not fail ingestion.
- Vector insert failure falls back to inserting rows without embeddings.

### Data Integrity Guarantees

- A file is not treated as successfully ingested until both `study_materials` and `study_material_chunks` rows exist.
- Chunk count is verified before returning material success.
- The frontend only advances to lesson focus after confirmed backend ingestion.
- Lesson generation uses saved material IDs, not raw local File objects.

### Frontend/Backend Contract Enforcement

- Upload selection is separate from material ingestion.
- The lesson prompt appears only after successful DB-backed ingestion.
- Partial failures are surfaced through structured `fileErrors`.

## Required Environment Variables

Create `.env.local`:

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
- `SUPABASE_SERVICE_ROLE_KEY` is used only by trusted server-side routes.
- `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are used by browser and route clients.
- `NEXT_PUBLIC_APP_URL` should be your deployed app origin in production.

## Supabase Setup

Apply the schema and migrations in `supabase/migrations`.

The database includes:

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

pgvector must be enabled:

```sql
create extension if not exists vector;
```

The chunk embedding migration adds:

```sql
alter table public.study_material_chunks
  add column if not exists embedding vector(1536);
```

## Stripe Setup

- Create monthly and yearly subscription prices.
- Put price IDs in `STRIPE_PRICE_MONTHLY` and `STRIPE_PRICE_YEARLY`.
- Configure Stripe Billing Portal.
- Configure a webhook endpoint for `/api/stripe/webhook`.
- Put the webhook signing secret in `STRIPE_WEBHOOK_SECRET`.

Stripe webhooks sync paid status and plan state into Supabase profiles.

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

Run production checks:

```bash
npm run build
```

## Deployment Notes

For Vercel:

- Set all environment variables in Vercel project settings.
- Apply Supabase migrations before deploying dependent routes.
- Confirm Stripe webhook URL points to the deployed `/api/stripe/webhook`.
- Watch Vercel runtime logs for ingestion, embedding, retrieval, rerank, and generation stages.

The app is serverless-compatible. Long-running work is bounded by file size limits, chunk limits, retrieval limits, and retry caps.

## Example Use Case

Upload:

- Security+ study guide
- PenTest+ notes

Prompt:

> Explain common network ports from attacker and defender perspectives.

QuizML will:

- combine relevant chunks from both documents
- generate a lesson with offensive and defensive context
- create exam-style questions
- adapt review signals based on incorrect answers

## Demo Flow

```text
Upload -> Ingest -> Select Materials -> Generate -> Miss Question -> Remediate -> Pass Final Test
```

## Future Improvements

- Smarter reranking models
- Topic clustering across documents
- Study progress dashboard
- Personalized difficulty scaling
- Exportable notes and flashcards
- Full lesson-run history picker

## Why This Project Stands Out

QuizML is not just an AI wrapper.

It demonstrates:

- real-world RAG architecture
- multi-document reasoning
- production-grade ingestion reliability
- vector database integration
- adaptive learning system design
- SaaS monetization with Stripe

## Resume Bullets

- Built a full-stack AI learning SaaS with Next.js App Router, Supabase, Stripe subscriptions, and Vercel deployment.
- Implemented a production RAG pipeline with PDF ingestion, chunk storage, OpenAI embeddings, pgvector retrieval, keyword fallback, LLM reranking, and traceable lesson runs.
- Designed resilient multi-file ingestion with verified chunk persistence, embedding failure fallback, and strict frontend/backend contract enforcement.
- Built schema-validated AI lesson generation with micro-lessons, quizzes, final mastery tests, concept tags, and persisted resume state.

## Contact

Built by **Lyndon St. Luce**

M.S. Computer Science @ Syracuse University
