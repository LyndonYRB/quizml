# QuizML.ai

AI-powered microlearning from your study materials.

Source Code: https://github.com/LyndonYRB/quizml

## Project Overview
QuizML is an AI learning SaaS that turns raw PDFs into structured lessons, quizzes, and remedial review loops. Instead of uploading notes and passively reading them, learners ingest their own materials, generate focused lesson sets, and work through a mastery-based flow that requires full understanding before moving on.

This project is built for students, certification candidates, and self-learners who already have content but need a more active study system. The core problem it solves is the gap between having study material and actually retaining it: most tools summarize content, but few enforce mastery against the learner's own documents.

## Live Demo
https://quizml.vercel.app

## Screenshots
### 1. Upload Study Materials
![Upload](public/screenshots/quizml-01-upload.png)

### 2. Saved Materials
![Saved Materials](public/screenshots/quizml-02-saved-materials.png)

### 3. Focus Prompt
![Focus Prompt](public/screenshots/quizml-03-focus.png)

### 4. AI Lesson Output
![Lesson](public/screenshots/quizml-04-lesson.png)

### 5. Quiz Flow
![Quiz](public/screenshots/quizml-05-quiz.png)

### 6. Remedial Review
![Remedial](public/screenshots/quizml-06-remedial.png)

### 7. Final Mastery Test
![Final Test](public/screenshots/quizml-07-final-test.png)

### 8. Completion
![Completion](public/screenshots/quizml-08-score.png)

## Tech Stack
- Next.js 16 App Router
- TypeScript
- Tailwind CSS
- Supabase Auth
- Supabase Postgres
- Supabase Storage
- Stripe Billing
- OpenAI API
- Vercel

## Architecture
High-level flow:

`User uploads PDFs -> ingest API creates queued ingestion records -> BullMQ job -> worker uploads to Supabase Storage -> study_materials row -> text extraction -> chunk creation -> AI lesson generation -> quiz/review experience`

Detailed flow:

1. User uploads one or more PDFs from the web app.
2. Files are sent to `/api/ingest-materials`.
3. The API authenticates the user, creates `study_material_ingestions` rows, base64-encodes the uploaded files, and enqueues one BullMQ job.
4. A separate worker process picks up the job from Redis.
5. Each PDF is uploaded to Supabase Storage.
6. A `study_materials` row is created for each successful file.
7. Text is extracted server-side from the uploaded PDF.
8. Extracted text is split into chunks and persisted in `study_material_chunks`.
9. Lesson generation retrieves relevant chunks and asks OpenAI to produce structured lessons and quizzes.
10. The learner moves through lessons, mastery quizzes, remedial review, and a final test.

## Ingestion Pipeline
QuizML uses a backend-backed ingestion status system plus a Redis-backed background worker instead of doing PDF processing inside the request itself.

Per-file statuses:
- `queued`
- `uploading`
- `extracting`
- `saving`
- `chunking`
- `ready`
- `failed`

Implementation notes:
- `study_material_ingestions` stores the current ingestion state for each uploaded file.
- `client_file_id` is generated in the frontend for each selected file and persisted with the ingestion row.
- `client_file_id` prevents collisions when two uploaded files share the same filename.
- The frontend polls `/api/study-material-ingestions` while ingestion is running.
- Failed ingestions persist `error_message`, so the UI can show per-file failure feedback.
- BullMQ + Redis handle job dispatch to the worker process.

## Data Model
Main tables used by the app:

- `profiles`
  Stores plan, paid status, Stripe customer/subscription ids, billing state, and subscription metadata.
- `daily_usage`
  Tracks daily lesson generation limits for free users.
- `study_materials`
  Stores saved PDFs and their storage-backed file references.
- `study_material_ingestions`
  Stores per-file ingestion lifecycle status and error information.
- `study_material_chunks`
  Stores chunked study content used for retrieval and lesson generation.
- `lesson_runs`
  Stores generated lesson sets, final test content, and run metadata.
- `lesson_run_materials`
  Links lesson runs to the source study materials used to generate them.
- `lesson_run_chunks`
  Links lesson runs to the retrieved chunks used during generation.
- `concept_mastery`
  Tracks mastery and review scheduling signals by concept.
- `question_attempts`
  Stores quiz attempt history.
- `question_reports`
  Stores reported question issues or feedback.

## SaaS Features
- Email/password authentication with Supabase Auth
- Saved study materials per user
- Open saved PDFs from signed URLs when storage is private
- Delete saved PDFs and related stored records
- Free vs paid usage controls
- Stripe-backed subscription support
- Billing portal / subscription management support
- Real per-file ingestion status during PDF import

## Reliability / Production Behavior
- The ingest API returns immediately after queueing, so long-running PDF work does not block the request lifecycle.
- Upload failures stop material creation before broken `study_materials` rows are finalized.
- Failed storage uploads do not leave orphaned DB records behind.
- Worker-side failures clean up partial storage or DB writes for the affected file.
- Storage cleanup runs when failed ingests or deleted materials need file removal.
- Legacy broken `file_url` values no longer render as valid Open links.
- Password validation now requires length, uppercase, lowercase, number, and special character before signup submission.
- Signup only shows the email verification prompt after successful Supabase signup.
- Supabase errors are surfaced to the UI instead of generic failure messages.
- Per-file ingestion failures return clear `error_message` values to the frontend.
- Verification email delivery depends on correct Supabase email provider / SMTP configuration in the deployed environment.

## Scaling Discussion
### How I would scale this to 10k users
- Use worker processes for storage upload verification, PDF parsing, chunking, embeddings, and retries.
- Add retry policies for transient failures in storage, OpenAI, and embeddings generation.
- Add rate limiting at auth, ingestion, and generation endpoints.
- Cache expensive retrieval/generation metadata where safe.
- Expand database indexing around ingestion lookup, retrieval paths, and usage checks.
- Add structured observability: request ids, per-stage timing, ingestion traces, and alerting.
- Add object-storage lifecycle policies and cleanup jobs for abandoned or rolled-back artifacts.
- Introduce cost controls around token usage, model routing, and chunk-selection strategy.

## Known Limitations
- Status updates are delivered through polling, not WebSockets or SSE.
- Large PDFs may still need more advanced worker autoscaling, chunked uploads, and job progress reporting.
- AI cost optimization can still be expanded with more aggressive retrieval and caching strategies.

## Future Work
- Adaptive quiz engine with deeper personalization
- Spaced repetition scheduling improvements
- Rich embeddings search over saved materials
- Admin dashboard for ingestion and subscription visibility
- Analytics dashboard for learning progress and retention
- Background workers for ingestion and generation pipelines

## Local Setup
```bash
git clone https://github.com/LyndonYRB/quizml
cd quizml
npm install
```

Create a `.env.local` file in the project root, then start the app:

```bash
npm run dev
```

Visit `http://localhost:3000`.

Run the background worker in a separate terminal:

```bash
npm run worker
```

## Environment Variables
Required application variables:

```env
OPENAI_API_KEY=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_APP_URL=http://localhost:3000
REDIS_URL=
```

Stripe variables:

```env
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_MONTHLY=
STRIPE_PRICE_YEARLY=
```

Optional:

```env
SUPABASE_STUDY_MATERIALS_BUCKET=study-materials
```

Notes:
- Use Stripe test-mode keys locally.
- Keep `NEXT_PUBLIC_APP_URL=http://localhost:3000` for local development unless you intentionally change the local domain.
- `REDIS_URL` is required for the BullMQ queue and worker.
- Supabase Auth email verification requires a valid email provider / SMTP configuration in Supabase.

## Deployment
QuizML is designed for Vercel deployment with Supabase, Stripe, and OpenAI configured through environment variables.

The Next.js web application can deploy to Vercel, but the BullMQ ingestion worker is a separate long-running process. Vercel does not automatically run `npm run worker`, so production requires Redis plus a separately hosted worker process.

The current queue payload includes base64-encoded PDF bytes for each file. That is acceptable for this stage of the project, but for larger-scale production workloads it should eventually move to storage-backed job payloads that pass references instead of full file contents.

Recommended environment separation:
- Production: live Stripe values, production app URL
- Preview: Stripe test mode only
- Development: local/test keys only

## Why This Project Matters
QuizML is a good example of a modern AI SaaS system because it combines:
- document ingestion
- storage-backed asset handling
- retrieval-oriented content processing
- LLM-generated learning experiences
- subscription logic
- reliability fixes for real production failure modes

It is not just a UI demo. It includes the kinds of operational details that make an AI product usable in production: ingestion visibility, rollback behavior, private file access, deletion, usage gating, and SaaS billing integration.
