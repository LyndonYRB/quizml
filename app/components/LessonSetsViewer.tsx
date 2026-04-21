// app/components/LessonSetsViewer.tsx
"use client";

import { useEffect, useMemo, useState } from "react";

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

type FinalTestQuestion = QuizQuestion & {
  lessonIndex: number;
  lessonTitle: string;
};

type Phase =
  | "lesson"
  | "quiz"
  | "remedialLesson"
  | "remedialQuiz"
  | "final"
  | "finalRemedialLesson"
  | "finalRemedialQuiz";

export interface LessonProgressState {
  phase: Phase;
  currentLessonIndex: number;
  completedLessonIndexes: number[];
  selectedAnswers: Record<string, number>;
  showResults: boolean;
  missedQuestions: QuizQuestion[];
  finalAnswers: Record<string, number>;
  showFinalResults: boolean;
  finalMissedQuestions: FinalTestQuestion[];
}

interface LessonSetsViewerProps {
  lessons: Lesson[];
  finalTest?: QuizQuestion[];
  lessonRunId: string | null;
  initialProgress?: Partial<LessonProgressState> | null;
  onProgressChange?: (progress: LessonProgressState) => void;
  onComplete: () => void;
  onBack: () => void;
}

function normalizeCorrectAnswerIndex(question: QuizQuestion) {
  const options = question.options ?? [];
  const raw = question.correctAnswer;

  if (typeof raw === "number" && Number.isFinite(raw)) {
    const n = Math.trunc(raw);
    if (n >= 0 && n < options.length) return n;
    if (n === options.length) return n - 1;
  }

  if (typeof raw === "string") {
    const answer = raw.trim();
    const letter = answer.toUpperCase().match(/^([A-Z])(?:[\).:-]|$)/)?.[1];

    if (letter) {
      const idx = letter.charCodeAt(0) - 65;
      if (idx >= 0 && idx < options.length) return idx;
    }

    const numeric = Number(answer);
    if (Number.isFinite(numeric)) {
      return normalizeCorrectAnswerIndex({ ...question, correctAnswer: numeric });
    }

    const textIndex = options.findIndex(
      (option) => option.trim().toLowerCase() === answer.toLowerCase()
    );
    if (textIndex >= 0) return textIndex;
  }

  return -1;
}

function buildRemedialQuiz(source: QuizQuestion[], missed: QuizQuestion[]) {
  const result: QuizQuestion[] = [];
  const missedConcepts = new Set(missed.map((question) => question.conceptTag));

  for (const question of missed) {
    if (!result.some((q) => q.question === question.question)) {
      result.push(question);
    }
  }

  for (const question of source) {
    if (
      missedConcepts.has(question.conceptTag) &&
      !result.some((q) => q.question === question.question)
    ) {
      result.push(question);
    }
  }

  return result.slice(0, 3);
}

function buildFinalRemedialQuiz(
  source: FinalTestQuestion[],
  missed: FinalTestQuestion[]
) {
  const result: FinalTestQuestion[] = [];
  const missedConcepts = new Set(missed.map((question) => question.conceptTag));

  for (const question of missed) {
    if (!result.some((q) => q.question === question.question)) {
      result.push(question);
    }
  }

  for (const question of source) {
    if (
      missedConcepts.has(question.conceptTag) &&
      !result.some((q) => q.question === question.question)
    ) {
      result.push(question);
    }
  }

  return result.slice(0, 3).map((question) => ({ ...question, hint: undefined }));
}

function isPhase(value: unknown): value is Phase {
  return (
    value === "lesson" ||
    value === "quiz" ||
    value === "remedialLesson" ||
    value === "remedialQuiz" ||
    value === "final" ||
    value === "finalRemedialLesson" ||
    value === "finalRemedialQuiz"
  );
}

function stableQuestionKey(scope: string, question: QuizQuestion, idx: number) {
  return [
    scope,
    idx,
    question.conceptTag.trim(),
    question.question.trim(),
  ].join("::");
}

const REPORT_REASONS = [
  "Not covered in lesson",
  "Marked wrong incorrectly",
  "Ambiguous wording",
  "Factually incorrect",
  "Duplicate or irrelevant",
  "Other",
] as const;

type ReportReason = (typeof REPORT_REASONS)[number];

function sanitizeAnswerMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 3) {
      result[key] = raw;
    }
  }
  return result;
}

function sanitizeProgress(
  value: Partial<LessonProgressState> | null | undefined
): LessonProgressState {
  const currentLessonIndex =
    typeof value?.currentLessonIndex === "number" &&
    Number.isInteger(value.currentLessonIndex) &&
    value.currentLessonIndex >= 0 &&
    value.currentLessonIndex <= 4
      ? value.currentLessonIndex
      : 0;

  return {
    phase: isPhase(value?.phase) ? value.phase : "lesson",
    currentLessonIndex,
    completedLessonIndexes: Array.isArray(value?.completedLessonIndexes)
      ? value.completedLessonIndexes.filter(
          (idx) => Number.isInteger(idx) && idx >= 0 && idx <= 4
        )
      : [],
    selectedAnswers: sanitizeAnswerMap(value?.selectedAnswers),
    showResults: Boolean(value?.showResults),
    missedQuestions: Array.isArray(value?.missedQuestions)
      ? value.missedQuestions
      : [],
    finalAnswers: sanitizeAnswerMap(value?.finalAnswers),
    showFinalResults: Boolean(value?.showFinalResults),
    finalMissedQuestions: Array.isArray(value?.finalMissedQuestions)
      ? value.finalMissedQuestions
      : [],
  };
}

function answersToArray(
  questions: QuizQuestion[],
  answers: Record<string, number>,
  scope: string
) {
  return questions.map((question, idx) => {
    const selected = answers[stableQuestionKey(scope, question, idx)];
    return typeof selected === "number" ? selected : -1;
  });
}

export default function LessonSetsViewer({
  lessons,
  finalTest,
  lessonRunId,
  initialProgress,
  onProgressChange,
  onComplete,
  onBack,
}: LessonSetsViewerProps) {
  const mainLessons = lessons.slice(0, 5);
  const restoredProgress = useMemo(
    () => sanitizeProgress(initialProgress),
    [initialProgress]
  );
  const [phase, setPhase] = useState<Phase>(restoredProgress.phase);
  const [currentLessonIndex, setCurrentLessonIndex] = useState(
    restoredProgress.currentLessonIndex
  );
  const [completedLessonIndexes, setCompletedLessonIndexes] = useState<number[]>(
    restoredProgress.completedLessonIndexes
  );
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, number>>(
    restoredProgress.selectedAnswers
  );
  const [showResults, setShowResults] = useState(restoredProgress.showResults);
  const [missedQuestions, setMissedQuestions] = useState<QuizQuestion[]>(
    restoredProgress.missedQuestions
  );
  const [finalAnswers, setFinalAnswers] = useState<Record<string, number>>(
    restoredProgress.finalAnswers
  );
  const [showFinalResults, setShowFinalResults] = useState(
    restoredProgress.showFinalResults
  );
  const [finalMissedQuestions, setFinalMissedQuestions] = useState<
    FinalTestQuestion[]
  >(restoredProgress.finalMissedQuestions);
  const [reportContext, setReportContext] = useState<{
    questionKey: string;
    questionText: string;
    questionSource: string;
    selectedAnswer: number | null;
    correctAnswer: number | null;
  } | null>(null);
  const [reportReason, setReportReason] = useState<ReportReason>(
    "Not covered in lesson"
  );
  const [reportNote, setReportNote] = useState("");
  const [reportLoading, setReportLoading] = useState(false);
  const [reportMessage, setReportMessage] = useState<string | null>(null);

  const currentLesson = mainLessons[currentLessonIndex];
  const isRemedial = phase === "remedialLesson" || phase === "remedialQuiz";
  const [finalTestQuestions] = useState<FinalTestQuestion[]>(() => {
    return finalTest?.length === 10
      ? finalTest.map((question, idx) => ({
          ...question,
          hint: undefined,
          lessonIndex: idx,
          lessonTitle: "Final Test",
        }))
      : [];
  });

  const mainQuiz = currentLesson?.quiz.slice(0, 3) ?? [];
  const remedialQuiz = buildRemedialQuiz(mainQuiz, missedQuestions);
  const currentQuiz = phase === "remedialQuiz" ? remedialQuiz : mainQuiz;
  const finalRemedialQuiz = buildFinalRemedialQuiz(
    finalTestQuestions,
    finalMissedQuestions
  );
  const currentAnswerScope =
    phase === "remedialQuiz"
      ? `lesson-${currentLessonIndex}-remedial`
      : `lesson-${currentLessonIndex}`;

  function getQuestionSourceLabel(): string {
    if (phase === "final") return "Final Test";
    if (phase === "finalRemedialQuiz") return "Final Remedial Quiz";
    if (phase === "remedialQuiz") return "Remedial Quiz";
    return "Lesson Quiz";
  }

  function openReport(
    questionKey: string,
    questionText: string,
    selectedAnswer: number | null,
    correctAnswer: number | null
  ) {
    setReportContext({
      questionKey,
      questionText,
      questionSource: getQuestionSourceLabel(),
      selectedAnswer,
      correctAnswer,
    });
    setReportReason("Not covered in lesson");
    setReportNote("");
    setReportMessage(null);
  }

  function closeReport() {
    if (reportLoading) return;
    setReportContext(null);
    setReportMessage(null);
  }

  async function submitQuestionReport() {
    if (!reportContext) return;
    setReportLoading(true);
    setReportMessage(null);

    try {
      const response = await fetch("/api/question-report", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lessonRunId,
          questionKey: reportContext.questionKey,
          questionSource: reportContext.questionSource,
          questionText: reportContext.questionText,
          selectedAnswer: reportContext.selectedAnswer,
          correctAnswer: reportContext.correctAnswer,
          reason: reportReason,
          note: reportNote || null,
        }),
      });

      const data = await response.json();
      if (!response.ok || data?.error) {
        throw new Error(data?.error || "Failed to submit report");
      }

      setReportMessage("Question report submitted. Thank you.");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to submit report.";
      setReportMessage(message);
    } finally {
      setReportLoading(false);
    }
  }

  useEffect(() => {
    onProgressChange?.({
      phase,
      currentLessonIndex,
      completedLessonIndexes,
      selectedAnswers,
      showResults,
      missedQuestions,
      finalAnswers,
      showFinalResults,
      finalMissedQuestions,
    });
  }, [
    phase,
    currentLessonIndex,
    completedLessonIndexes,
    selectedAnswers,
    showResults,
    missedQuestions,
    finalAnswers,
    showFinalResults,
    finalMissedQuestions,
    onProgressChange,
  ]);

  if (!currentLesson || mainLessons.length < 5 || finalTestQuestions.length !== 10) {
    return (
      <div className="mx-auto max-w-2xl rounded-lg bg-gray-800 p-8 shadow-xl">
        <h2 className="text-2xl font-bold text-white">Generation incomplete</h2>
        <p className="mt-3 text-gray-300">
          This run did not match the required mastery format. Please generate a
          fresh lesson set.
        </p>
        <button
          onClick={onBack}
          className="mt-6 rounded-lg bg-blue-500 px-6 py-3 font-semibold text-white hover:bg-blue-600"
        >
          Back to Upload
        </button>
      </div>
    );
  }

  function logCompletedCycleAttempts(
    source: "lesson_mastered" | "final_attempted",
    questions: QuizQuestion[],
    answers: number[]
  ) {
    const attempts = questions.map((question, idx) => ({
      conceptTag: question.conceptTag,
      question: question.question,
      selectedAnswer: answers[idx] >= 0 ? answers[idx] : null,
      correctAnswer: normalizeCorrectAnswerIndex(question),
    }));

    fetch("/api/attempt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lessonRunId,
        source,
        attempts,
      }),
    }).catch(() => {});
  }

  function getMissed<T extends QuizQuestion>(
    questions: T[],
    answers: Record<string, number>,
    scope: string
  ) {
    return questions.filter((question, idx) => {
      const correctAnswer = normalizeCorrectAnswerIndex(question);
      const selected = answers[stableQuestionKey(scope, question, idx)];
      return selected !== correctAnswer;
    });
  }

  function selectAnswer(questionKey: string, optionIndex: number) {
    setSelectedAnswers((answers) => ({
      ...answers,
      [questionKey]: optionIndex,
    }));
  }

  function selectFinalAnswer(questionKey: string, optionIndex: number) {
    setFinalAnswers((answers) => ({
      ...answers,
      [questionKey]: optionIndex,
    }));
  }

  function submitCurrentQuiz() {
    const answerArray = answersToArray(
      currentQuiz,
      selectedAnswers,
      currentAnswerScope
    );
    const missed = getMissed(currentQuiz, selectedAnswers, currentAnswerScope);
    if (missed.length === 0) {
      logCompletedCycleAttempts("lesson_mastered", currentQuiz, answerArray);
    }
    setMissedQuestions(missed);
    setShowResults(true);
  }

  function continueAfterQuiz() {
    const missed = getMissed(currentQuiz, selectedAnswers, currentAnswerScope);
    setMissedQuestions(missed);

    if (missed.length > 0) {
      setSelectedAnswers({});
      setShowResults(false);
      setPhase("remedialLesson");
      return;
    }

    goToNextMainStep();
  }

  function goToNextMainStep() {
    setSelectedAnswers({});
    setShowResults(false);
    setMissedQuestions([]);
    setCompletedLessonIndexes((indexes) =>
      indexes.includes(currentLessonIndex)
        ? indexes
        : [...indexes, currentLessonIndex].sort()
    );

    if (currentLessonIndex < 4) {
      setCurrentLessonIndex((idx) => idx + 1);
      setPhase("lesson");
      return;
    }

    setPhase("final");
  }

  function submitFinalTest() {
    const answerArray = answersToArray(finalTestQuestions, finalAnswers, "final");
    const missed = getMissed(finalTestQuestions, finalAnswers, "final");
    logCompletedCycleAttempts("final_attempted", finalTestQuestions, answerArray);
    setFinalMissedQuestions(missed);
    setShowFinalResults(true);
  }

  function continueAfterFinalResults() {
    const missed = getMissed(finalTestQuestions, finalAnswers, "final");
    setFinalMissedQuestions(missed);

    if (missed.length === 0) {
      onComplete();
      return;
    }

    setFinalAnswers({});
    setShowFinalResults(false);
    setPhase("finalRemedialLesson");
  }

  function submitFinalRemedialQuiz() {
    const missed = getMissed(
      finalRemedialQuiz,
      selectedAnswers,
      "final-remedial"
    );
    setFinalMissedQuestions(missed);
    setShowResults(true);
  }

  function continueAfterFinalRemediation() {
    const missed = getMissed(
      finalRemedialQuiz,
      selectedAnswers,
      "final-remedial"
    );
    setFinalMissedQuestions(missed);

    if (missed.length > 0) {
      setSelectedAnswers({});
      setShowResults(false);
      setPhase("finalRemedialLesson");
      return;
    }

    setSelectedAnswers({});
    setShowResults(false);
    setFinalAnswers({});
    setShowFinalResults(false);
    setPhase("final");
  }

  function renderRemedialLessonCard({
    title,
    questions,
    onStart,
  }: {
    title: string;
    questions: QuizQuestion[];
    onStart: () => void;
  }) {
    const concepts = [...new Set(questions.map((q) => q.conceptTag))];

    return (
      <div className="mx-auto max-w-5xl">
        <div className="rounded-lg border border-yellow-500 bg-yellow-900/30 p-6">
          <h2 className="text-3xl font-bold text-yellow-400">{title}</h2>
          <p className="mt-3 text-gray-300">
            Review only the missed concept area before trying the remedial quiz.
          </p>
        </div>

        <div className="mt-6 rounded-lg border border-gray-700 bg-gray-800 p-8 shadow-xl">
          <h3 className="text-xl font-bold text-white">Focus Concepts</h3>
          <div className="mt-3 flex flex-wrap gap-2">
            {concepts.map((concept) => (
              <span
                key={concept}
                className="rounded-full border border-yellow-600 bg-yellow-900/30 px-3 py-1 text-sm text-yellow-300"
              >
                {concept}
              </span>
            ))}
          </div>

          <div className="mt-6 space-y-4">
            {questions.map((question, idx) => (
              <div
                key={`${question.conceptTag}-${question.question}`}
                className="rounded-lg bg-gray-700 p-4"
              >
                <p className="font-semibold text-blue-300">
                  Remedial point {idx + 1}
                </p>
                <p className="mt-2 text-gray-200">{question.explanation}</p>
              </div>
            ))}
          </div>
        </div>

        <button
          onClick={onStart}
          className="mt-8 w-full rounded-lg bg-blue-500 px-6 py-4 text-lg font-semibold text-white hover:bg-blue-600"
        >
          Start Remedial Quiz
        </button>
      </div>
    );
  }

  function renderQuizView({
    title,
    questions,
    answers,
    answerScope,
    showHints,
    onSelect,
    onSubmit,
    onContinue,
    continueLabel,
  }: {
    title: string;
    questions: QuizQuestion[];
    answers: Record<string, number>;
    answerScope: string;
    showHints: boolean;
    onSelect: (questionKey: string, optionIndex: number) => void;
    onSubmit: () => void;
    onContinue: () => void;
    continueLabel: string;
  }) {
    const resultsVisible = phase === "final" ? showFinalResults : showResults;
    const missedCount =
      phase === "final" || phase === "finalRemedialQuiz"
        ? finalMissedQuestions.length
        : missedQuestions.length;
    const score = questions.length - missedCount;
    const answeredCount = questions.filter(
      (question, idx) =>
        answers[stableQuestionKey(answerScope, question, idx)] !== undefined
    ).length;

    return (
      <div className="mx-auto max-w-5xl">
        <div className="mb-8 rounded-lg border border-gray-700 bg-gray-800 p-6">
          <h2 className="text-2xl font-bold text-blue-400">{title}</h2>
          <p className="mt-2 text-sm text-gray-300">
            Forced mastery: all questions must be correct before moving on.
          </p>
        </div>

        <div className="rounded-lg border border-gray-700 bg-gray-800 p-8 shadow-xl">
          {questions.map((question, qIdx) => {
            const correctAnswer = normalizeCorrectAnswerIndex(question);
            const questionKey = stableQuestionKey(answerScope, question, qIdx);

            return (
              <div
                key={questionKey}
                className="mb-10 border-b border-gray-700 pb-8 last:border-0"
              >
                <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-lg font-semibold text-white">
                    Question {qIdx + 1}: {question.question}
                  </p>
                  <button
                    onClick={() =>
                      openReport(
                        questionKey,
                        question.question,
                        typeof answers[questionKey] === "number"
                          ? answers[questionKey]
                          : null,
                        correctAnswer >= 0 ? correctAnswer : null
                      )
                    }
                    className="inline-flex items-center rounded-full border border-gray-600 bg-gray-900 px-3 py-2 text-sm font-semibold text-gray-200 transition hover:border-gray-500 hover:bg-gray-800"
                  >
                    Report Question
                  </button>
                </div>

                {showHints && question.hint && (
                  <div className="mb-4 rounded-lg border border-blue-700 bg-blue-900/20 p-3">
                    <p className="text-sm text-blue-300">
                      <span className="font-semibold">Hint:</span>{" "}
                      {question.hint}
                    </p>
                  </div>
                )}

                {reportContext?.questionKey === questionKey && (
                  <div className="mb-6 rounded-lg border border-gray-600 bg-gray-900 p-4 text-sm text-gray-100">
                    <div className="mb-4 space-y-2">
                      <p className="font-semibold text-white">Report preview</p>
                      <p>{reportContext.questionText}</p>
                      <p className="text-gray-400">
                        Source: {reportContext.questionSource}
                      </p>
                    </div>

                    <label className="mb-2 block text-xs uppercase tracking-wide text-gray-300">
                      Reason
                    </label>
                    <select
                      value={reportReason}
                      onChange={(event) =>
                        setReportReason(event.target.value as ReportReason)
                      }
                      className="mb-4 w-full rounded border border-gray-700 bg-black/10 px-3 py-2 text-sm text-white"
                    >
                      {REPORT_REASONS.map((reason) => (
                        <option key={reason} value={reason}>
                          {reason}
                        </option>
                      ))}
                    </select>

                    <label className="mb-2 block text-xs uppercase tracking-wide text-gray-300">
                      Notes (optional)
                    </label>
                    <textarea
                      value={reportNote}
                      onChange={(event) => setReportNote(event.target.value)}
                      rows={3}
                      className="mb-4 w-full resize-none rounded border border-gray-700 bg-black/10 px-3 py-2 text-sm text-white"
                      placeholder="Optional details for the review team"
                    />

                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <button
                        onClick={submitQuestionReport}
                        disabled={reportLoading}
                        className="inline-flex items-center justify-center rounded-lg bg-blue-500 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-gray-600"
                      >
                        {reportLoading ? "Submitting..." : "Submit Report"}
                      </button>
                      <button
                        onClick={closeReport}
                        disabled={reportLoading}
                        className="inline-flex items-center justify-center rounded-lg border border-gray-600 bg-transparent px-4 py-2 text-sm font-semibold text-gray-200 hover:border-gray-500 hover:text-white"
                      >
                        Close
                      </button>
                    </div>

                    {reportMessage && (
                      <p
                        className={`mt-4 text-sm ${
                          reportMessage.includes("Thank you")
                            ? "text-green-400"
                            : "text-red-400"
                        }`}
                      >
                        {reportMessage}
                      </p>
                    )}
                  </div>
                )}

                <div className="space-y-3">
                  {question.options.map((option, oIdx) => {
                    const isSelected = answers[questionKey] === oIdx;
                    const isCorrect = oIdx === correctAnswer;
                    const showCorrect = resultsVisible && isCorrect;
                    const showIncorrect =
                      resultsVisible && isSelected && !isCorrect;

                    return (
                      <button
                        key={`${questionKey}-${oIdx}-${option}`}
                        onClick={() =>
                          !resultsVisible && onSelect(questionKey, oIdx)
                        }
                        disabled={resultsVisible}
                        className={`w-full rounded-lg border-2 p-4 text-left font-semibold text-white transition ${
                          showCorrect
                            ? "border-green-500 bg-green-900/30"
                            : showIncorrect
                            ? "border-red-500 bg-red-900/30"
                            : isSelected
                            ? "border-blue-500 bg-blue-900/30"
                            : "border-gray-600 bg-gray-700 hover:border-gray-500"
                        } ${resultsVisible ? "cursor-default" : "cursor-pointer"}`}
                      >
                        <span className="mr-3 font-mono font-bold">
                          {String.fromCharCode(65 + oIdx)}.
                        </span>
                        {option}
                      </button>
                    );
                  })}
                </div>

                {resultsVisible && (
                  <div className="mt-4 rounded-lg border-l-4 border-blue-500 bg-gray-700 p-4">
                    <p className="mb-2 text-sm font-semibold text-blue-300">
                      EXPLANATION:
                    </p>
                    <p className="text-sm leading-relaxed text-gray-300">
                      {question.explanation}
                    </p>
                  </div>
                )}
              </div>
            );
          })}

          {!resultsVisible ? (
            <button
              onClick={onSubmit}
              disabled={answeredCount !== questions.length}
              className="w-full rounded-lg bg-blue-500 px-6 py-4 text-lg font-semibold text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-gray-600"
            >
              Submit Quiz ({answeredCount}/{questions.length} answered)
            </button>
          ) : (
            <div>
              <div
                className={`mb-6 rounded-lg border-2 p-6 ${
                  score === questions.length
                    ? "border-green-500 bg-green-900/30"
                    : "border-yellow-500 bg-yellow-900/30"
                }`}
              >
                <h3 className="text-2xl font-bold">
                  Score: {score}/{questions.length}
                </h3>
                <p className="mt-2 text-gray-300">
                  {phase === "finalRemedialQuiz"
                    ? missedCount === 0
                      ? "Remediation cleared. Return to the same final test."
                      : "Review the missed final-test concepts again."
                    : missedCount === 0
                    ? "Mastery cleared."
                    : "Remediation required before moving on."}
                </p>
              </div>

              <button
                onClick={onContinue}
                className="w-full rounded-lg bg-blue-500 px-6 py-4 text-lg font-semibold text-white hover:bg-blue-600"
              >
                {continueLabel}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (phase === "lesson") {
    return (
      <div className="mx-auto max-w-5xl">
        <div className="mb-8">
          <div className="mb-2 flex justify-between text-sm text-gray-400">
            <span>
              Main Micro-Lesson {currentLessonIndex + 1} of {mainLessons.length}
            </span>
            <span>
              {Math.round(((currentLessonIndex + 1) / mainLessons.length) * 100)}
              % Complete
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-gray-700">
            <div
              className="h-2 rounded-full bg-blue-500 transition-all"
              style={{
                width: `${
                  ((currentLessonIndex + 1) / mainLessons.length) * 100
                }%`,
              }}
            />
          </div>
        </div>

        <div className="rounded-lg border border-gray-700 bg-gray-800 p-8 shadow-xl">
          <h2 className="mb-8 text-3xl font-bold text-blue-400">
            {currentLesson.title}
          </h2>

          <section className="mb-8">
            <h3 className="mb-3 text-xl font-bold text-white">What It Is</h3>
            <p className="leading-relaxed text-gray-300">
              {currentLesson.whatItIs}
            </p>
          </section>

          <section className="mb-8">
            <h3 className="mb-3 text-xl font-bold text-white">Key Points</h3>
            <ul className="list-inside list-disc space-y-2 text-gray-300">
              {currentLesson.keyPoints.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </section>

          <section className="mb-8">
            <h3 className="mb-3 text-xl font-bold text-white">
              What to Look For on the Exam
            </h3>
            <div className="flex flex-wrap gap-2">
              {currentLesson.examKeywords.map((keyword) => (
                <span
                  key={keyword}
                  className="rounded-full border border-yellow-600 bg-yellow-900/30 px-3 py-1 text-sm text-yellow-300"
                >
                  {keyword}
                </span>
              ))}
            </div>
          </section>

          <section>
            <h3 className="mb-3 text-xl font-bold text-red-400">
              Common Exam Traps
            </h3>
            <div className="space-y-3">
              {currentLesson.commonTraps.map((trap, idx) => (
                <div
                  key={trap}
                  className="rounded-lg border border-red-800 bg-red-900/20 p-4"
                >
                  <p className="text-gray-300">
                    <span className="font-bold text-red-400">
                      Trap {idx + 1}:
                    </span>{" "}
                    {trap}
                  </p>
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="mt-8 text-center">
          <button
            onClick={() => {
              setSelectedAnswers({});
              setShowResults(false);
              setPhase("quiz");
            }}
            className="rounded-lg bg-blue-500 px-8 py-4 text-lg font-semibold text-white hover:bg-blue-600"
          >
            Start 3-Question Mastery Quiz
          </button>
          <button
            onClick={onBack}
            className="mx-auto mt-4 block text-gray-400 hover:text-white"
          >
            Back to Upload
          </button>
        </div>
      </div>
    );
  }

  if (phase === "remedialLesson") {
    return renderRemedialLessonCard({
      title: "Remedial Micro-Lesson",
      questions: remedialQuiz,
      onStart: () => {
        setSelectedAnswers({});
        setShowResults(false);
        setPhase("remedialQuiz");
      },
    });
  }

  if (phase === "quiz" || phase === "remedialQuiz") {
    return renderQuizView({
      title: isRemedial
        ? "Remedial Mastery Quiz"
        : `Lesson ${currentLessonIndex + 1} Mastery Quiz`,
      questions: currentQuiz,
      answers: selectedAnswers,
      answerScope: currentAnswerScope,
      showHints: true,
      onSelect: selectAnswer,
      onSubmit: submitCurrentQuiz,
      onContinue: continueAfterQuiz,
      continueLabel:
        missedQuestions.length > 0
          ? "Study Remedial Micro-Lesson"
          : currentLessonIndex < 4
          ? "Next Main Micro-Lesson"
          : "Unlock Final Test",
    });
  }

  if (phase === "final") {
    return (
      <div className="mx-auto max-w-5xl">
        <div className="mb-8 rounded-lg border-2 border-red-500 bg-red-900/30 p-6">
          <h2 className="text-3xl font-bold text-red-400">
            FINAL MASTERY TEST
          </h2>
          <p className="mt-2 text-gray-300">
            Exactly 10 questions. No hints. You must score 10/10 to complete.
          </p>
        </div>

        {renderQuizView({
          title: "Final Test",
          questions: finalTestQuestions,
          answers: finalAnswers,
          answerScope: "final",
          showHints: false,
          onSelect: selectFinalAnswer,
          onSubmit: submitFinalTest,
          onContinue: continueAfterFinalResults,
          continueLabel:
            finalMissedQuestions.length === 0
              ? "Complete Course"
              : "Study Final Remediation",
        })}
      </div>
    );
  }

  if (phase === "finalRemedialLesson") {
    return renderRemedialLessonCard({
      title: "Final Test Remediation",
      questions: finalRemedialQuiz,
      onStart: () => {
        setSelectedAnswers({});
        setShowResults(false);
        setPhase("finalRemedialQuiz");
      },
    });
  }

  return renderQuizView({
    title: "Final Remedial Quiz",
    questions: finalRemedialQuiz,
    answers: selectedAnswers,
    answerScope: "final-remedial",
    showHints: true,
    onSelect: selectAnswer,
    onSubmit: submitFinalRemedialQuiz,
    onContinue: continueAfterFinalRemediation,
    continueLabel:
      finalMissedQuestions.length === 0
        ? "Retake Same Final Test"
        : "Review Final Remediation Again",
  });
}
