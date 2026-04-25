// app/components/FileUpload.tsx
"use client";

import { useEffect, useState } from "react";
import LessonFocusForm from "./LessonFocusForm";
import LessonSetsViewer, { LessonProgressState } from "./LessonSetsViewer";
import PricingButtons from "./PricingButtons";


/* =========================================================
   TYPES
========================================================= */

interface QuizQuestion {
  question: string;
  options: string[];
  correctAnswer: number | string;
  hint?: string;
  explanation: string;
  conceptTag: string;
}

interface Lesson {
  title: string;
  whatItIs: string;
  keyPoints: string[];
  examKeywords: string[];
  commonTraps: string[];
  quiz: QuizQuestion[];
}

interface CachedLesson {
  schemaVersion?: number;
  lessonRunId?: string | null;
  fileName: string;
  fileSize: number;
  focusTopic: string;
  lessons: Lesson[];
  finalTest?: QuizQuestion[];
  progress?: Partial<LessonProgressState> | null;
  timestamp: number;
}

interface ReviewDueItem {
  conceptTag: string;
  nextReview: string; // ISO
  streak: number;
}

interface ReviewDueRow {
  concept_tag?: unknown;
  next_review?: unknown;
  streak?: unknown;
}

interface StudyMaterial {
  id: string;
  file_name: string;
  file_url: string;
  created_at: string;
  open_url?: string | null;
  file_available?: boolean;
}

interface UsageResponse {
  usage?: {
    remaining?: number;
    limit?: number;
    isPaid?: boolean;
    plan?: string;
    subscriptionStatus?: string | null;
    currentPeriodEnd?: string | null;
    priceId?: string | null;
    cancelAtPeriodEnd?: boolean;
  };
}

interface LessonRunResponse {
  success?: boolean;
  lessonRunId?: string;
  lessons?: Lesson[];
  finalTest?: QuizQuestion[];
  progress?: Partial<LessonProgressState> | null;
  error?: string;
}

interface StudyMaterialsResponse {
  success?: boolean;
  studyMaterials?: StudyMaterial[];
  error?: string;
}

interface IngestMaterialsResponse {
  success?: boolean;
  studyMaterials?: StudyMaterial[];
  chunkCounts?: Record<string, number>;
  fileErrors?: Array<{
    fileName?: string;
    stage?: string;
    message?: string;
  }>;
  error?: string;
  message?: string;
}

interface StudyMaterialIngestion {
  id: string;
  client_file_id?: string | null;
  file_name: string;
  status: IngestStatus;
  error_message?: string | null;
  study_material_id?: string | null;
  created_at: string;
  updated_at: string;
}

interface StudyMaterialIngestionsResponse {
  success?: boolean;
  ingestions?: StudyMaterialIngestion[];
  error?: string;
}

type IngestFeedback = {
  type: "success" | "partial" | "error";
  message: string;
  details?: string[];
};

type IngestStatus =
  | "queued"
  | "uploading"
  | "extracting"
  | "saving"
  | "chunking"
  | "ready"
  | "failed";

type LocalFileStatus = {
  status: IngestStatus;
  errorMessage?: string;
};

type LocalSelectedFile = {
  clientFileId: string;
  file: File;
};


/* =========================================================
   CONSTANTS
========================================================= */

const FREE_DAILY_LIMIT = 5;
const MAX_FILE_BYTES_FREE = 10 * 1024 * 1024; // 10MB
const MAX_FILE_BYTES_PAID = 50 * 1024 * 1024; // 50MB
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CACHE_SCHEMA_VERSION = 2;
const ACTIVE_RUN_STORAGE_PREFIX = "relrn_active_run";
const RUN_PROGRESS_STORAGE_PREFIX = "relrn_run_progress";
const RUN_QUERY_PARAM = "lessonRunId";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidQuestion(
  question: QuizQuestion,
  options: { requireHint?: boolean; forbidHint?: boolean } = {}
) {
  const hasValidAnswer =
    typeof question.correctAnswer === "number" ||
    isNonEmptyString(question.correctAnswer);
  const hasHint =
    Object.prototype.hasOwnProperty.call(question, "hint");

  return (
    isNonEmptyString(question.question) &&
    Array.isArray(question.options) &&
    question.options.length === 4 &&
    question.options.every(isNonEmptyString) &&
    hasValidAnswer &&
    isNonEmptyString(question.explanation) &&
    isNonEmptyString(question.conceptTag) &&
    (!options.requireHint || isNonEmptyString(question.hint)) &&
    (!options.forbidHint || !hasHint)
  );
}

function isValidLesson(lesson: Lesson) {
  return (
    isNonEmptyString(lesson.title) &&
    isNonEmptyString(lesson.whatItIs) &&
    Array.isArray(lesson.keyPoints) &&
    lesson.keyPoints.length > 0 &&
    lesson.keyPoints.every(isNonEmptyString) &&
    Array.isArray(lesson.examKeywords) &&
    lesson.examKeywords.length > 0 &&
    lesson.examKeywords.every(isNonEmptyString) &&
    Array.isArray(lesson.commonTraps) &&
    lesson.commonTraps.length > 0 &&
    lesson.commonTraps.every(isNonEmptyString) &&
    Array.isArray(lesson.quiz) &&
    lesson.quiz.length === 3 &&
    lesson.quiz.every((question) =>
      isValidQuestion(question, { requireHint: true })
    )
  );
}

function isValidMasteryCache(
  data: CachedLesson
): data is CachedLesson & { lessonRunId: string; finalTest: QuizQuestion[] } {
  return (
    data.schemaVersion === CACHE_SCHEMA_VERSION &&
    isNonEmptyString(data.lessonRunId) &&
    Array.isArray(data.lessons) &&
    data.lessons.length === 5 &&
    data.lessons.every(isValidLesson) &&
    Array.isArray(data.finalTest) &&
    data.finalTest.length === 10 &&
    data.finalTest.every((question) =>
      isValidQuestion(question, { forbidHint: true })
    )
  );
}

function getActiveRunStorageKey(userId: string) {
  return `${ACTIVE_RUN_STORAGE_PREFIX}_${userId}`;
}

function getRunProgressStorageKey(userId: string, lessonRunId: string) {
  return `${RUN_PROGRESS_STORAGE_PREFIX}_${userId}_${lessonRunId}`;
}

function setActiveLessonRunReference(userId: string, lessonRunId: string) {
  localStorage.setItem(getActiveRunStorageKey(userId), lessonRunId);

  const url = new URL(window.location.href);
  url.searchParams.set(RUN_QUERY_PARAM, lessonRunId);
  window.history.replaceState({}, "", url.toString());
}

function clearActiveLessonRunReference(userId: string | null) {
  if (userId) {
    localStorage.removeItem(getActiveRunStorageKey(userId));
  }

  const url = new URL(window.location.href);
  url.searchParams.delete(RUN_QUERY_PARAM);
  window.history.replaceState({}, "", url.toString());
}

function readStoredRunProgress(userId: string, lessonRunId: string) {
  const raw = localStorage.getItem(getRunProgressStorageKey(userId, lessonRunId));
  if (!raw) return null;

  try {
    return JSON.parse(raw) as Partial<LessonProgressState>;
  } catch {
    localStorage.removeItem(getRunProgressStorageKey(userId, lessonRunId));
    return null;
  }
}

function formatMaterialDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function ingestStatusLabel(status: IngestStatus) {
  switch (status) {
    case "queued":
      return "Queued";
    case "uploading":
      return "Uploading";
    case "extracting":
      return "Extracting text";
    case "saving":
      return "Saving material";
    case "chunking":
      return "Creating chunks";
    case "ready":
      return "Ready";
    case "failed":
      return "Failed";
  }
}

function ingestStatusClasses(status: IngestStatus) {
  switch (status) {
    case "ready":
      return "bg-emerald-500/15 text-emerald-200";
    case "failed":
      return "bg-red-500/15 text-red-200";
    case "queued":
      return "bg-gray-600/40 text-gray-200";
    default:
      return "bg-blue-500/15 text-blue-200";
  }
}

function materialsSignature(materialIds: string[]) {
  return [...materialIds].sort().join("|");
}

function materialsDisplayName(materials: StudyMaterial[]) {
  if (materials.length === 1) return materials[0].file_name;
  return `${materials.length} materials`;
}

function canOpenStudyMaterial(material: StudyMaterial) {
  return Boolean(material.file_available && material.open_url);
}

function materialSourceSummary(count: number) {
  if (count <= 1) return "Built from 1 saved study material.";
  return `Built from ${count} saved study materials. Cross-document mode enabled.`;
}

function mergeStudyMaterials(
  currentMaterials: StudyMaterial[],
  nextMaterials: StudyMaterial[]
) {
  const byId = new Map(currentMaterials.map((material) => [material.id, material]));

  nextMaterials.forEach((material) => {
    byId.set(material.id, material);
  });

  return Array.from(byId.values()).sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
}

function selectedMaterialsSummary(count: number, isPaid: boolean) {
  if (count === 0) {
    return isPaid
      ? "Select saved materials or upload PDFs to start."
      : "Select one saved material or upload one PDF to start.";
  }

  if (count === 1) return "1 material selected";
  return `${count} materials selected`;
}

function StepIndicator({ currentStep }: { currentStep: "upload" | "learn" }) {
  const steps = ["Upload", "Ingest", "Learn", "Test"];
  const activeIndex = currentStep === "upload" ? 0 : 2;

  return (
    <div className="mb-5 flex items-center gap-2 text-xs text-gray-400">
      {steps.map((step, index) => (
        <div key={step} className="flex items-center gap-2">
          <span
            className={`rounded-full px-2 py-1 font-medium ${
              index <= activeIndex
                ? "bg-blue-500/20 text-blue-200"
                : "bg-gray-700 text-gray-400"
            }`}
          >
            {step}
          </span>
          {index < steps.length - 1 ? <span className="text-gray-600">→</span> : null}
        </div>
      ))}
    </div>
  );
}

/* =========================================================
   COMPONENT
========================================================= */

type FileUploadProps = {
  isAuthed: boolean;
  userId: string | null;
  onOpenAuth?: () => void;
};

export default function FileUpload({ isAuthed, userId, onOpenAuth }: FileUploadProps) {


  /* ---------------------------------------------------------
     STATE: File + UI flow
  --------------------------------------------------------- */

  const [files, setFiles] = useState<LocalSelectedFile[]>([]);
  const [showFocusForm, setShowFocusForm] = useState(false);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [finalTest, setFinalTest] = useState<QuizQuestion[]>([]);
  const [lessonRunId, setLessonRunId] = useState<string | null>(null);
  const [activeLessonRunId, setActiveLessonRunId] = useState<string | null>(null);
  const [initialProgress, setInitialProgress] = useState<
    Partial<LessonProgressState> | null
  >(null);

  /* ---------------------------------------------------------
     STATE: Loading / feedback
  --------------------------------------------------------- */

  const [uploading, setUploading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [ingestFeedback, setIngestFeedback] = useState<IngestFeedback | null>(null);
  const [fileStatuses, setFileStatuses] = useState<Record<string, LocalFileStatus>>({});

  /* ---------------------------------------------------------
     STATE: Daily usage (client display only)
     NOTE: This is currently localStorage-based. Later, we will
     swap to DB-backed usage using data.usage from the API.
  --------------------------------------------------------- */

  const [generationsLeft, setGenerationsLeft] = useState(FREE_DAILY_LIMIT);
  const [usageLimit, setUsageLimit] = useState(FREE_DAILY_LIMIT);
  const [isPaid, setIsPaid] = useState(false);
  const [planName, setPlanName] = useState("free");
  const [subscriptionStatus, setSubscriptionStatus] = useState<string | null>(null);
  const [currentPeriodEnd, setCurrentPeriodEnd] = useState<string | null>(null);
  const [cancelAtPeriodEnd, setCancelAtPeriodEnd] = useState(false);

    /* ---------------------------------------------------------
     STATE: Review Due (Spaced repetition)
  --------------------------------------------------------- */

  const [reviewDue, setReviewDue] = useState<ReviewDueItem[]>([]);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [showReviewScreen, setShowReviewScreen] = useState(false);
  const [studyMaterials, setStudyMaterials] = useState<StudyMaterial[]>([]);
  const [selectedStudyMaterialIds, setSelectedStudyMaterialIds] = useState<string[]>([]);

  const maxFileBytes = isPaid ? MAX_FILE_BYTES_PAID : MAX_FILE_BYTES_FREE;
  const maxFileMb = maxFileBytes / 1024 / 1024;



  /* =========================================================
     EFFECTS
  ========================================================= */

    useEffect(() => {
    if (!isAuthed) {
      setGenerationsLeft(FREE_DAILY_LIMIT);
      setUsageLimit(FREE_DAILY_LIMIT);
      setIsPaid(false);
      setPlanName("free");
      setSubscriptionStatus(null);
      setCurrentPeriodEnd(null);
      setCancelAtPeriodEnd(false);
      setStudyMaterials([]);
      setSelectedStudyMaterialIds([]);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const res = await fetch("/api/usage", { method: "GET" });
        const data = (await res.json().catch(() => ({}))) as UsageResponse;

        if (!cancelled && res.ok && data?.usage) {
          if (data.usage.remaining !== undefined) {
            setGenerationsLeft(data.usage.remaining);
          }
          if (data.usage.limit !== undefined) {
            setUsageLimit(data.usage.limit);
          }
          setIsPaid(Boolean(data.usage.isPaid));
          setPlanName(data.usage.plan ?? "free");
          setSubscriptionStatus(data.usage.subscriptionStatus ?? null);
          setCurrentPeriodEnd(data.usage.currentPeriodEnd ?? null);
          setCancelAtPeriodEnd(Boolean(data.usage.cancelAtPeriodEnd));
        }
      } catch {
        // Silent fail: backend still enforces limits
      }
    })();

      return () => {
        cancelled = true;
      };
    }, [isAuthed, userId]);

    /* ---------------------------------------------------------
      EFFECT: Load all saved study materials after auth
    --------------------------------------------------------- */

    useEffect(() => {
      if (!isAuthed) {
        setStudyMaterials([]);
        return;
      }

      let cancelled = false;

      (async () => {
        try {
          const res = await fetch("/api/study-materials", { method: "GET" });
          const data = (await res.json().catch(() => ({}))) as StudyMaterialsResponse;

          if (!cancelled && res.ok && Array.isArray(data.studyMaterials)) {
            setStudyMaterials(data.studyMaterials);
            setSelectedStudyMaterialIds((currentIds) =>
              currentIds.filter((id) =>
                data.studyMaterials?.some((material) => material.id === id)
              )
            );
          }
        } catch {
          // Silent fail: upload/generation still works without the list.
        }
      })();

      return () => {
        cancelled = true;
      };
    }, [isAuthed, userId]);

    /* ---------------------------------------------------------
      EFFECT: Load review due after auth
    --------------------------------------------------------- */

    useEffect(() => {
      if (!isAuthed) {
        setReviewDue([]);
        return;
      }

      let cancelled = false;

      (async () => {
        setReviewLoading(true);
        try {
          const res = await fetch("/api/review-due?limit=20", { method: "GET" });
          const data = await res.json().catch(() => ({}));

          if (!cancelled && res.ok && Array.isArray(data?.due)) {
          const normalized: ReviewDueItem[] = data.due.map((row: ReviewDueRow) => ({
            conceptTag: String(row.concept_tag ?? ""),
            nextReview: String(row.next_review ?? ""),
            streak: Number(row.streak ?? 0),
          })).filter((x: ReviewDueItem) => x.conceptTag);

          setReviewDue(normalized);
        } else if (!cancelled && res.ok) {
          setReviewDue([]);
        }


        } catch {
          // silent fail
        } finally {
          if (!cancelled) setReviewLoading(false);
        }
      })();

      return () => {
        cancelled = true;
      };
    }, [isAuthed, userId]);

    /* ---------------------------------------------------------
      EFFECT: Restore active persisted lesson run after reload
    --------------------------------------------------------- */

    useEffect(() => {
      if (!isAuthed || !userId || lessons.length > 0) return;

      const urlRunId = new URL(window.location.href).searchParams.get(RUN_QUERY_PARAM);
      const storedRunId = localStorage.getItem(getActiveRunStorageKey(userId));
      const runId = urlRunId || storedRunId;

      setActiveLessonRunId(runId);
    }, [isAuthed, userId, lessons.length]);


  /* =========================================================
  HANDLERS
  ========================================================= */

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(e.target.files ?? []);
    if (selectedFiles.length === 0) return;

    if (!isPaid && selectedFiles.length > 1) {
      alert("Free plan supports one PDF at a time. Only the first file was selected.");
    }

    const candidateFiles = isPaid ? selectedFiles : selectedFiles.slice(0, 1);
    const oversizedFile = candidateFiles.find((selected) => selected.size > maxFileBytes);
    if (oversizedFile) {
      alert(`${oversizedFile.name} exceeds the ${maxFileMb}MB limit for your plan.`);
      e.target.value = "";
      return;
    }

    const nextFiles = isPaid
      ? [
          ...files,
          ...candidateFiles
            .filter(
              (candidate) =>
                !files.some(
                  (currentFile) =>
                    currentFile.file.name === candidate.name &&
                    currentFile.file.size === candidate.size &&
                    currentFile.file.lastModified === candidate.lastModified
                )
            )
            .map((candidate) => ({
              clientFileId: crypto.randomUUID(),
              file: candidate,
            })),
        ]
      : candidateFiles.map((candidate) => ({
          clientFileId: crypto.randomUUID(),
          file: candidate,
        }));

    if (isPaid && nextFiles.length === files.length) {
      alert("Those files are already selected.");
      e.target.value = "";
      return;
    }

    setFiles(nextFiles);
    setFileStatuses(
      Object.fromEntries(
        nextFiles.map((file) => [
          file.clientFileId,
          { status: "queued" satisfies IngestStatus },
        ])
      )
    );
    setLessons([]);
    setFinalTest([]);
    setLessonRunId(null);
    setActiveLessonRunId(null);
    setInitialProgress(null);
    clearActiveLessonRunReference(userId);
    setIngestFeedback(null);
    setShowFocusForm(false);
    e.target.value = "";
  }

  async function handleUploadClick() {
    if (files.length === 0 && selectedStudyMaterialIds.length === 0) return;

    if (files.length === 0) {
      setShowFocusForm(true);
      return;
    }

    setUploading(true);
    setLoadingMsg("Processing your PDFs...");
    setIngestFeedback(null);
    setFileStatuses(
      Object.fromEntries(
        files.map((file) => [file.clientFileId, { status: "queued" as IngestStatus }])
      )
    );

    let pollingInterval: number | null = null;
    let stoppedPolling = false;
    let latestStatusesByClientFileId = new Map<string, StudyMaterialIngestion>();

    try {
      const startedAfter = new Date().toISOString();
      const ingestFormData = new FormData();
      files.forEach((selectedFile) => {
        ingestFormData.append("files", selectedFile.file);
        ingestFormData.append("client_file_id", selectedFile.clientFileId);
      });

      const ingestRequest = fetch("/api/ingest-materials", {
        method: "POST",
        body: ingestFormData,
      });

      const pollIngestionStatuses = async () => {
        const params = new URLSearchParams();
        params.set("startedAfter", startedAfter);
        files.forEach((file) => {
          params.append("clientFileId", file.clientFileId);
        });

        try {
          const res = await fetch(`/api/study-material-ingestions?${params.toString()}`, {
            method: "GET",
          });
          const data = (await res
            .json()
            .catch(() => ({}))) as StudyMaterialIngestionsResponse;

          if (!res.ok || !Array.isArray(data.ingestions)) return;

          const latestByClientFileId = new Map(
            data.ingestions
              .filter((ingestion) => ingestion.client_file_id)
              .map((ingestion) => [ingestion.client_file_id as string, ingestion])
          );
          latestStatusesByClientFileId = latestByClientFileId;

          setFileStatuses((current) =>
            Object.fromEntries(
              files.map((file) => {
                const key = file.clientFileId;
                const ingestion = latestByClientFileId.get(file.clientFileId);
                return [
                  key,
                  ingestion
                    ? {
                        status: ingestion.status,
                        errorMessage: ingestion.error_message ?? undefined,
                      }
                    : current[key] ?? { status: "queued" as IngestStatus },
                ];
              })
            )
          );
        } catch {
          // Silent fail while the main request is in flight.
        }
      };

      await pollIngestionStatuses();
      pollingInterval = window.setInterval(() => {
        if (!stoppedPolling) {
          void pollIngestionStatuses();
        }
      }, 1000);

      const ingestResponse = await ingestRequest;
      stoppedPolling = true;
      if (pollingInterval !== null) {
        window.clearInterval(pollingInterval);
      }
      await pollIngestionStatuses();

      const ingestData = (await ingestResponse
        .json()
        .catch(() => ({}))) as IngestMaterialsResponse;
      const ingestedMaterials = Array.isArray(ingestData.studyMaterials)
        ? ingestData.studyMaterials
        : [];

      if (!ingestResponse.ok || !ingestData.success || ingestedMaterials.length === 0) {
        const failureMessage =
          ingestData.message ||
          ingestData.error ||
          "Failed to ingest study material.";
        console.error("Ingestion failed:", ingestData);
        setFileStatuses((current) =>
          Object.fromEntries(
            files.map((file) => {
              const key = file.clientFileId;
              return [
                key,
                {
                  ...(current[key] ?? { status: "queued" as IngestStatus }),
                  status: "failed" as IngestStatus,
                  errorMessage: failureMessage,
                },
              ];
            })
          )
        );
        setIngestFeedback({
          type: "error",
          message: "No files were imported.",
          details: [failureMessage],
        });
        alert(failureMessage);
        return;
      }

      setLoadingMsg("Building your study library...");

      if (ingestData.fileErrors?.length) {
        console.warn("Ingestion completed with file errors:", ingestData.fileErrors);
      }

      setFileStatuses((current) =>
        Object.fromEntries(
          files.map((file) => {
            const key = file.clientFileId;
            const latestStatus = latestStatusesByClientFileId.get(file.clientFileId);

            if (latestStatus) {
              return [
                key,
                {
                  ...(current[key] ?? { status: "queued" as IngestStatus }),
                  status: latestStatus.status,
                  errorMessage: latestStatus.error_message ?? undefined,
                },
              ];
            }

            return [
              key,
              {
                ...(current[key] ?? { status: "queued" as IngestStatus }),
                status: "failed" as IngestStatus,
                errorMessage: "Import failed.",
              },
            ];
          })
        )
      );

      const refreshedMaterials = await refreshStudyMaterials();
      const nextStudyMaterials =
        refreshedMaterials.length > 0
          ? refreshedMaterials
          : mergeStudyMaterials(studyMaterials, ingestedMaterials);
      const ingestedIds = ingestedMaterials.map((material) => material.id);

      setStudyMaterials(nextStudyMaterials);
      setSelectedStudyMaterialIds(isPaid ? ingestedIds : ingestedIds.slice(0, 1));
      setFiles([]);
      setIngestFeedback({
        type: ingestData.fileErrors?.length ? "partial" : "success",
        message: ingestData.fileErrors?.length
          ? `Imported ${ingestedMaterials.length} file${
              ingestedMaterials.length === 1 ? "" : "s"
            }, ${ingestData.fileErrors.length} failed.`
          : `Successfully imported ${ingestedMaterials.length} study material${
              ingestedMaterials.length === 1 ? "" : "s"
            }.`,
        details: ingestData.fileErrors?.map((error) =>
          `${error.fileName || "File"}: ${error.message || "Import failed."}`
        ),
      });
      setShowFocusForm(true);
    } finally {
      stoppedPolling = true;
      if (typeof pollingInterval === "number") {
        window.clearInterval(pollingInterval);
      }
      setUploading(false);
      setLoadingMsg("");
    }
  }

  function clearFile() {
    setFiles([]);
    setFileStatuses({});
    setLessons([]);
    setFinalTest([]);
    setLessonRunId(null);
    setActiveLessonRunId(null);
    setInitialProgress(null);
    clearActiveLessonRunReference(userId);
    setIngestFeedback(null);
    setShowFocusForm(false);
  }

  function removeFile(indexToRemove: number) {
    const removedFile = files[indexToRemove];
    if (!removedFile) return;

    setFiles((currentFiles) =>
      currentFiles.filter((_, index) => index !== indexToRemove)
    );
    setFileStatuses((currentStatuses) => {
      const nextStatuses = { ...currentStatuses };
      delete nextStatuses[removedFile.clientFileId];
      return nextStatuses;
    });
  }

  function toggleStudyMaterial(materialId: string) {
    setSelectedStudyMaterialIds((currentIds) => {
      if (currentIds.includes(materialId)) {
        return currentIds.filter((id) => id !== materialId);
      }

      if (!isPaid) {
        return [materialId];
      }

      return [...currentIds, materialId];
    });
  }

  async function refreshStudyMaterials() {
    const materialsRes = await fetch("/api/study-materials", { method: "GET" });
    const materialsData = (await materialsRes
      .json()
      .catch(() => ({}))) as StudyMaterialsResponse;

    if (materialsRes.ok && Array.isArray(materialsData.studyMaterials)) {
      setStudyMaterials(materialsData.studyMaterials);
    }

    return materialsData.studyMaterials ?? [];
  }

  function handleStartReview() {
    if (!reviewDue.length) {
      alert("No reviews due right now.");
      return;
    }

    setShowReviewScreen(true);
  }

  async function handleResumeLesson() {
    if (!activeLessonRunId || !userId) return;

    setUploading(true);
    setLoadingMsg("Restoring saved lesson run...");

    try {
      const res = await fetch(
        `/api/lesson-run/${encodeURIComponent(activeLessonRunId)}`,
        { method: "GET" }
      );
      const data = (await res.json().catch(() => ({}))) as LessonRunResponse;
      const restoredRun = {
        schemaVersion: CACHE_SCHEMA_VERSION,
        lessonRunId: data.lessonRunId ?? null,
        fileName: "",
        fileSize: 0,
        focusTopic: "",
        lessons: Array.isArray(data.lessons) ? data.lessons : [],
        finalTest: Array.isArray(data.finalTest) ? data.finalTest : [],
        progress:
          data.lessonRunId && userId
            ? readStoredRunProgress(userId, data.lessonRunId) ?? data.progress ?? null
            : data.progress ?? null,
        timestamp: Date.now(),
      };

      if (!res.ok || !data?.success || !isValidMasteryCache(restoredRun)) {
        clearActiveLessonRunReference(userId);
        setActiveLessonRunId(null);
        alert(data?.error || "Saved lesson run could not be restored.");
        return;
      }

      setLessons(restoredRun.lessons);
      setFinalTest(restoredRun.finalTest);
      setLessonRunId(restoredRun.lessonRunId);
      setInitialProgress(restoredRun.progress ?? null);
      setActiveLessonRunReference(userId, restoredRun.lessonRunId);
      setActiveLessonRunId(restoredRun.lessonRunId);
    } catch {
      clearActiveLessonRunReference(userId);
      setActiveLessonRunId(null);
      alert("Saved lesson run could not be restored.");
    } finally {
      setUploading(false);
      setLoadingMsg("");
    }
  }

  function handleProgressChange(progress: LessonProgressState) {
    if (!isAuthed || !userId || !lessonRunId) return;

    localStorage.setItem(
      getRunProgressStorageKey(userId, lessonRunId),
      JSON.stringify(progress)
    );

    fetch(`/api/lesson-run/${encodeURIComponent(lessonRunId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ progress }),
    }).catch(() => {
      // Local progress is still available for same-browser resume.
    });
  }


  /* =========================================================
     CORE: Generate lessons
  ========================================================= */

  async function handleGenerateLessons(focusTopic: string) {
    if (selectedStudyMaterialIds.length === 0) {
      alert("Select or ingest at least one saved study material first.");
      setShowFocusForm(false);
      return;
    }

    /* ---------------------------------------------------------
       1) Cache lookup (skip API if cached & fresh)
    --------------------------------------------------------- */

    const generationMaterialIds = selectedStudyMaterialIds;
    const currentStudyMaterials = studyMaterials;

    if (generationMaterialIds.length === 0) return;

    if (!isPaid && generationMaterialIds.length !== 1) {
      alert("Free plan supports one study material at a time.");
      return;
    }

    const selectedMaterials = currentStudyMaterials.filter((material) =>
      generationMaterialIds.includes(material.id)
    );
    const selectedMaterialsSignature = materialsSignature(generationMaterialIds);
    const cacheKey = userId
      ? `relrn_materials_${userId}_${selectedMaterialsSignature}_${focusTopic}`
      : null;

    if (isAuthed && userId && cacheKey) {
      const cached = localStorage.getItem(cacheKey);

      if (cached) {
        try {
          const data: CachedLesson = JSON.parse(cached);

          if (
            Date.now() - data.timestamp < CACHE_TTL_MS &&
            isValidMasteryCache(data)
          ) {
            setLessons(data.lessons);
            setFinalTest(data.finalTest);
            setLessonRunId(data.lessonRunId);
            setInitialProgress(
              readStoredRunProgress(userId, data.lessonRunId) ?? data.progress ?? null
            );
            setActiveLessonRunReference(userId, data.lessonRunId);
            setActiveLessonRunId(data.lessonRunId);
            setShowFocusForm(false);
            return;
          }

          localStorage.removeItem(cacheKey); // expired or incompatible mastery schema
        } catch {
          localStorage.removeItem(cacheKey); // corrupted
        }
      }
    }


    /* ---------------------------------------------------------
       2) Start UI loading state
    --------------------------------------------------------- */

    setUploading(true);
    setLoadingMsg("Cross-referencing materials...");

    // Rotating status messages while the request runs.
    const messages = [
      "Cross-referencing materials...",
      "Generating micro-lessons...",
      "Creating quiz questions...",
      "Writing exam traps...",
      "Finalizing answers and explanations...",
    ];
    let i = 0;
    const ticker = setInterval(() => {
      setLoadingMsg(messages[i % messages.length]);
      i += 1;
    }, 2500);

    try {
      /* ---------------------------------------------------------
         3) Call API
      --------------------------------------------------------- */

      const response = await fetch("/api/generate-lessons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          focusTopic,
          studyMaterialIds: generationMaterialIds,
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        // Handle 429 nicely
        if (response.status === 429) {
          alert(data?.error || "Daily generation limit reached.");
          return;
        }
        throw new Error(data?.error || `Request failed (${response.status})`);
      }

      if (!data?.success) {
        throw new Error(data?.error || "Failed to process file.");
      }

      /* ---------------------------------------------------------
         4) Success: show lessons + update local UI usage
      --------------------------------------------------------- */

      setLessons(data.lessons);
      setFinalTest(Array.isArray(data.finalTest) ? data.finalTest : []);
      setLessonRunId(data.lessonRunId ?? null);
      setInitialProgress(null);
      if (isAuthed && userId && isNonEmptyString(data.lessonRunId)) {
        setActiveLessonRunReference(userId, data.lessonRunId);
        setActiveLessonRunId(data.lessonRunId);
      }
      setShowFocusForm(false);
      

      // Update local generation counter (UI-only)
      if (data.usage?.remaining !== undefined) {
        setGenerationsLeft(data.usage.remaining);
      }
      if (data.usage?.limit !== undefined) {
        setUsageLimit(data.usage.limit);
      }

      if (isAuthed) {
        await refreshStudyMaterials();
      }


      // Cache results
      const cacheData: CachedLesson = {
        schemaVersion: CACHE_SCHEMA_VERSION,
        fileName: materialsDisplayName(selectedMaterials),
        fileSize: 0,
        focusTopic,
        lessonRunId: data.lessonRunId ?? null,
        lessons: data.lessons,
        finalTest: Array.isArray(data.finalTest) ? data.finalTest : [],
        progress: null,
        timestamp: Date.now(),
      };
      if (isAuthed && userId && cacheKey) {
          if (!isValidMasteryCache(cacheData)) {
            throw new Error("Generated lesson run was not persisted completely.");
          }
            localStorage.setItem(cacheKey, JSON.stringify(cacheData));
        } 
    } catch (error) {
      console.error("Upload error:", error);
      alert(
        "Failed to process file: " +
          (error instanceof Error ? error.message : "Unknown error")
      );
    } finally {
      clearInterval(ticker);
      setUploading(false);
      setLoadingMsg("");
    }
  }

  /* =========================================================
     RENDER: Focus form step
  ========================================================= */

  if (showFocusForm && selectedStudyMaterialIds.length > 0) {
    const selectedMaterials = studyMaterials.filter((material) =>
      selectedStudyMaterialIds.includes(material.id)
    );

    return (
      <LessonFocusForm
  fileName={
    materialsDisplayName(selectedMaterials)
  }
  sourceSummary={materialSourceSummary(selectedMaterials.length)}
  onGenerate={handleGenerateLessons}
  onCancel={() => setShowFocusForm(false)}
  generationsLeft={generationsLeft}
  usageLimit={usageLimit}
  isPaid={isPaid}
  isLoading={uploading}
  loadingMsg={loadingMsg}
/>
    );
  }

  if (showReviewScreen) {
    return (
      <div className="max-w-2xl mx-auto p-8 bg-gray-800 rounded-lg shadow-xl">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold text-white">Review Queue</h2>
            <p className="mt-2 text-sm text-gray-300">
              These concepts are due based on your recent quiz attempts.
            </p>
          </div>
          <button
            onClick={() => setShowReviewScreen(false)}
            className="text-sm text-gray-400 hover:text-white transition"
          >
            Back
          </button>
        </div>

        <div className="space-y-3">
          {reviewDue.map((item) => (
            <div
              key={`${item.conceptTag}-${item.nextReview}`}
              className="rounded-lg border border-white/10 bg-gray-700 p-4"
            >
              <p className="font-semibold text-white">{item.conceptTag}</p>
              <p className="mt-1 text-sm text-gray-300">
                Current streak: {item.streak}
              </p>
            </div>
          ))}
        </div>

        <p className="mt-6 text-sm text-gray-400">
          Quick review mode is intentionally simple for now: revisit each
          concept, then generate a fresh lesson set when you are ready to drill
          again.
        </p>
      </div>
    );
  }

  /* =========================================================
     RENDER: Lesson viewer step
  ========================================================= */

  if (lessons.length > 0) {
    return (
      <div>
          <LessonSetsViewer
          lessons={lessons}
          finalTest={finalTest}
          lessonRunId={lessonRunId}
          initialProgress={initialProgress}
          onProgressChange={handleProgressChange}
          onComplete={() => {
            alert("Course completed. You achieved 100% mastery on the final test.");
            if (isAuthed && userId && lessonRunId) {
              localStorage.removeItem(getRunProgressStorageKey(userId, lessonRunId));
            }
            setLessons([]); // keep file so user can generate again
            setFinalTest([]);
            setLessonRunId(null);
            setActiveLessonRunId(null);
            setInitialProgress(null);
            clearActiveLessonRunReference(userId);
          }}
          onBack={() => {
            setLessons([]); // go back to upload screen
            setFinalTest([]);
            setLessonRunId(null);
            setInitialProgress(null);
            setActiveLessonRunId(lessonRunId);
          }}
        />

      </div>
    );
  }

  /* =========================================================
      RENDER: Auth gate (Blurred Preview + CTA opens modal)
     ========================================================= */

    if (!isAuthed) {
      return (
        <div className="relative mx-auto max-w-2xl">
          {/* Blurred preview (real UI, but disabled) */}
          <div className="pointer-events-none select-none blur-[2px] opacity-50">
            <div className="p-8 bg-gray-800 rounded-lg shadow-xl">
              <h2 className="text-2xl font-bold mb-6 text-white">Upload Study Material</h2>

              <div className="mb-4 p-3 bg-gray-700 rounded">
                <p className="text-sm text-blue-400">
                  Daily generations: {FREE_DAILY_LIMIT}/{FREE_DAILY_LIMIT} remaining
                </p>
              </div>

              <div className="mb-6">
                <label className="block mb-2 text-sm text-gray-300">
                  Choose a PDF file (max 10MB for free tier)
                </label>
                <div className="h-10 rounded-lg bg-gray-700 border border-gray-600" />
              </div>

              <button
                disabled
                className="w-full bg-gray-600 px-6 py-3 rounded-lg font-semibold"
              >
                Continue
              </button>
            </div>
          </div>

          {/* Overlay gate */}
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-full rounded-lg border border-white/10 bg-gray-900/60 backdrop-blur-md p-8 shadow-xl text-center">
              <h2 className="text-2xl font-bold text-white">Sign in to start learning</h2>
              <p className="mt-3 text-white/80">
                Upload a PDF and we will generate micro-lessons and quizzes.
              </p>
              <p className="mt-2 text-sm text-white/60">
                Free tier: {FREE_DAILY_LIMIT} generations/day (resets at 12:00 AM UTC)
              </p>

              <div className="mt-6 flex flex-col sm:flex-row gap-3 justify-center">
                <button
                  onClick={() => onOpenAuth?.()}
                  className="inline-flex items-center justify-center rounded-lg
                            bg-blue-500 px-6 py-3 font-semibold text-white
                            hover:bg-blue-600 transition"
                >
                  Sign In to Continue
                </button>

                <button
                  onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
                  className="inline-flex items-center justify-center rounded-lg
                            bg-white/10 px-6 py-3 font-semibold text-white
                            hover:bg-white/15 transition"
                >
                  Go to top
                </button>
              </div>

              <div className="mt-4 text-xs text-white/50">
                Tip: Use the top-right Sign In button anytime.
              </div>
            </div>
          </div>
        </div>
      );
    }


  /* =========================================================
     RENDER: Upload screen
  ========================================================= */

  return (
    <div className="max-w-2xl mx-auto p-8 bg-gray-800 rounded-lg shadow-xl text-white">
      <StepIndicator currentStep="upload" />
      <h2 className="text-2xl font-bold mb-6 text-white">Upload Study Material</h2>

      {/* Daily usage banner */}
      <div className="mb-4 p-3 bg-gray-700 rounded">
        <p className="text-sm text-blue-400">
          {isPaid
            ? `QuizML Pro ${planName} - unlimited generations`
            : `Daily generations: ${generationsLeft}/${usageLimit} remaining`}
        </p>
      </div>

      {activeLessonRunId ? (
        <div className="mb-4 p-3 bg-gray-700 rounded flex items-center justify-between gap-3">
          <p className="text-sm text-gray-200">
            You have an incomplete lesson run ready to continue.
          </p>

          <button
            onClick={handleResumeLesson}
            disabled={uploading}
            className="bg-blue-500 hover:bg-blue-600 disabled:bg-gray-600 disabled:text-white/60 disabled:cursor-not-allowed px-4 py-2 rounded-lg font-semibold text-sm transition"
          >
            Resume Lesson
          </button>
        </div>
      ) : (
        <div className="mb-4 p-3 bg-gray-700 rounded flex items-center justify-between gap-3">
          <p className="text-sm text-gray-200">
            Reviews due:{" "}
            <span className="font-bold text-white">
              {reviewLoading ? "..." : reviewDue.length}
            </span>
          </p>
          
          <button
            onClick={handleStartReview}
            disabled={reviewLoading || reviewDue.length === 0}
            className="bg-purple-500 hover:bg-purple-600 disabled:bg-gray-600 disabled:text-white/60 disabled:cursor-not-allowed px-4 py-2 rounded-lg font-semibold text-sm transition"
          >
            Start Review
          </button>
        </div>
      )}

      {ingestFeedback && (
        <div
          className={`mb-4 rounded-lg border p-4 ${
            ingestFeedback.type === "success"
              ? "border-emerald-400/30 bg-emerald-500/10"
              : ingestFeedback.type === "partial"
                ? "border-yellow-400/30 bg-yellow-500/10"
                : "border-red-400/30 bg-red-500/10"
          }`}
        >
          <p
            className={`text-sm font-semibold ${
              ingestFeedback.type === "success"
                ? "text-emerald-100"
                : ingestFeedback.type === "partial"
                  ? "text-yellow-100"
                  : "text-red-100"
            }`}
          >
            {ingestFeedback.message}
          </p>
          {ingestFeedback.details?.length ? (
            <ul className="mt-2 space-y-1 text-xs text-white/70">
              {ingestFeedback.details.map((detail, index) => (
                <li key={`${detail}-${index}`}>{detail}</li>
              ))}
            </ul>
          ) : null}
        </div>
      )}

      {studyMaterials.length > 0 && (
        <div className="mb-4 rounded-lg border border-white/10 bg-gray-700 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-white">Saved Study Materials</h3>
              <p className="mt-1 text-xs text-gray-400">
                {isPaid
                  ? "Previously ingested materials ready for lesson generation."
                  : "Previously ingested materials ready for lesson generation. Free plan can use one at a time."}
              </p>
            </div>
            {selectedStudyMaterialIds.length > 0 && (
              <button
                onClick={() => setSelectedStudyMaterialIds([])}
                className="shrink-0 text-sm text-red-400 hover:text-red-300 transition"
              >
                Clear
              </button>
            )}
          </div>
          <p className="mt-3 rounded bg-gray-800 px-3 py-2 text-xs font-medium text-blue-200">
            {selectedMaterialsSummary(selectedStudyMaterialIds.length, isPaid)}
          </p>
          <ul className="mt-3 space-y-2">
            {studyMaterials.map((material) => (
              <li
                key={material.id}
                className={`flex items-center justify-between gap-3 rounded border px-3 py-2 transition ${
                  selectedStudyMaterialIds.includes(material.id)
                    ? "border-blue-400 bg-blue-500/15"
                    : "border-transparent bg-gray-800"
                }`}
              >
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                  <input
                    type={isPaid ? "checkbox" : "radio"}
                    name="study-material"
                    checked={selectedStudyMaterialIds.includes(material.id)}
                    onChange={() => toggleStudyMaterial(material.id)}
                    className="h-4 w-4 accent-blue-500"
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-gray-100">
                      {material.file_name}
                    </span>
                    <span className="block text-xs text-gray-400">
                      {formatMaterialDate(material.created_at)}
                    </span>
                  </span>
                </label>
                {canOpenStudyMaterial(material) ? (
                  <a
                    href={material.open_url ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-sm font-semibold text-blue-400 hover:text-blue-300"
                  >
                    Open
                  </a>
                ) : (
                  <span className="shrink-0 text-sm font-semibold text-gray-500">
                    File unavailable
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* File input */}
      {!isPaid && (
        <div className="mb-4 rounded-lg border border-blue-400/30 bg-blue-500/10 p-4">
          <p className="text-sm font-semibold text-blue-100">Free plan</p>
          <p className="mt-1 text-sm text-blue-100/80">
            You can upload one PDF at a time. Upgrade to Pro to save and use
            multiple study materials.
          </p>
        </div>
      )}

      <div className="mb-6">
        <label className="block mb-2 text-sm text-gray-300">
          Choose local PDF files to ingest (max {maxFileMb}MB for {isPaid ? "paid" : "free"} plan)
        </label>
        <p className="mb-2 text-xs text-gray-400">
          Local files are not saved until ingestion completes successfully.
        </p>
        <input
          type="file"
          accept=".pdf"
          multiple={isPaid}
          onChange={handleFileChange}
          className="block w-full text-sm text-gray-300
            file:mr-4 file:py-2 file:px-4
            file:rounded-lg file:border-0
            file:bg-blue-500 file:text-white
            file:cursor-pointer hover:file:bg-blue-600"
        />
      </div>

      {/* Selected file card */}
      {files.length > 0 && (
        <div className="mb-6 p-4 bg-gray-700 rounded-lg">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-gray-200">
              Local files selected for ingestion
            </p>
            <button
              onClick={clearFile}
              className="text-sm text-red-400 hover:text-red-300 transition"
            >
              Remove all
            </button>
          </div>

          <ul className="mt-3 space-y-2">
            {files.map((selectedFile, index) => {
              const statusEntry =
                fileStatuses[selectedFile.clientFileId] ??
                ({ status: "queued" } as LocalFileStatus);

              return (
                <li
                  key={selectedFile.clientFileId}
                  className="flex items-center justify-between gap-3 rounded bg-gray-800 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm text-gray-200">
                        {selectedFile.file.name}
                      </p>
                      <span
                        className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-semibold ${ingestStatusClasses(
                          statusEntry.status
                        )}`}
                      >
                        {ingestStatusLabel(statusEntry.status)}
                      </span>
                    </div>
                    <p className="text-xs text-gray-400">
                      {(selectedFile.file.size / 1024 / 1024).toFixed(2)} MB
                    </p>
                    {statusEntry.errorMessage ? (
                      <p className="mt-1 text-xs text-red-300">
                        {statusEntry.errorMessage}
                      </p>
                    ) : null}
                  </div>
                  <button
                    onClick={() => removeFile(index)}
                    className="shrink-0 text-sm text-red-400 hover:text-red-300 transition"
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Continue button */}
      <button
        onClick={handleUploadClick}
        disabled={
          (files.length === 0 && selectedStudyMaterialIds.length === 0) ||
          uploading
        }
        className="w-full bg-blue-500 hover:bg-blue-600 disabled:bg-gray-600 
          disabled:text-white/60 disabled:cursor-not-allowed px-6 py-3 rounded-lg font-semibold transition"
      >
        {uploading
          ? "Processing..."
          : files.length > 0
            ? "Ingest and Continue"
            : selectedStudyMaterialIds.length > 0
              ? "Generate from Selected Materials"
              : "Continue"}
      </button>

      {/* Loading status box (shows during long generation call) */}
      {uploading && (
        <div className="mt-4 flex items-center gap-3 rounded-lg border border-white/10 bg-white/5 px-4 py-3">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          <div className="text-sm text-white/80">{loadingMsg || "Working..."}</div>
        </div>
      )}

      {uploading && (
        <div className="mt-2 text-xs text-white/50">
          Large PDFs can take up to ~60 seconds.
        </div>
      )}

      {/* Upgrade */}
      <PricingButtons
        isAuthed={isAuthed}
        isPaid={isPaid}
        planName={planName}
        subscriptionStatus={subscriptionStatus}
        currentPeriodEnd={currentPeriodEnd}
        cancelAtPeriodEnd={cancelAtPeriodEnd}
        onOpenAuth={onOpenAuth}
      />

    </div>
  );
}
