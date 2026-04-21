// app/components/LessonFocusForm.tsx
"use client";

import { useState } from "react";

/* =========================================================
   HELPERS
========================================================= */

function formatUtcResetTimeHint() {
  return "Resets at 12:00 AM UTC";
}

/* =========================================================
   TYPES
========================================================= */

interface LessonFocusFormProps {
  fileName: string;
  onGenerate: (focusTopic: string) => void | Promise<void>;
  onCancel: () => void;
  generationsLeft: number;
  usageLimit: number;
  isPaid: boolean;

  isLoading?: boolean;
  loadingMsg?: string;
}

/* =========================================================
   COMPONENT
========================================================= */

export default function LessonFocusForm({
  fileName,
  onGenerate,
  onCancel,
  generationsLeft,
  usageLimit,
  isPaid,
  isLoading = false,
  loadingMsg = "",
}: LessonFocusFormProps) {
  /* ---------------------------------------------------------
     STATE
  --------------------------------------------------------- */

  const [focusTopic, setFocusTopic] = useState("");

  /* ---------------------------------------------------------
     HANDLERS
  --------------------------------------------------------- */

  const handleSubmit = () => {
    if (isLoading) return;

    if (!focusTopic.trim()) {
      alert("Please tell us what you want to learn!");
      return;
    }

    onGenerate(focusTopic);
  };

  /* =========================================================
     RENDER
  ========================================================= */

  return (
    <div className="max-w-2xl mx-auto p-8 bg-gray-800 rounded-lg shadow-xl">
      {/* -------------------------------------------------------
          HEADER
      -------------------------------------------------------- */}
      <h2 className="text-2xl font-bold mb-4">What would you like to learn?</h2>

      {/* -------------------------------------------------------
          FILE + DAILY LIMIT INFO
      -------------------------------------------------------- */}
      <div className="mb-4 p-3 bg-gray-700 rounded">
        <p className="text-sm text-gray-300">
          <strong>File:</strong> {fileName}
        </p>
        <p className="text-sm text-blue-400 mt-1">
          {isPaid
            ? "QuizML Pro: unlimited generations"
            : `Generations remaining today: ${generationsLeft}/${usageLimit}`}
        </p>
      </div>

      {/* -------------------------------------------------------
          INPUT: FOCUS TOPIC
      -------------------------------------------------------- */}
      <div className="mb-6">
        <label className="block mb-2 text-sm text-gray-300">
          Focus your learning:
        </label>
        <textarea
          value={focusTopic}
          onChange={(e) => setFocusTopic(e.target.value)}
          placeholder={
            "Examples:\n" +
            "- Teach me about encryption and cryptography\n" +
            "- I need to understand threat actors and malware\n" +
            "- Focus on network security protocols\n" +
            "- Explain authentication methods"
          }
          className="w-full h-32 p-3 bg-gray-700 text-white rounded-lg border border-gray-600 focus:border-blue-500 focus:outline-none resize-none"
          maxLength={500}
          disabled={isLoading}
        />
        <p className="text-xs text-gray-400 mt-1">
          {focusTopic.length}/500 characters
        </p>
      </div>

      {/* -------------------------------------------------------
          LIMIT REACHED WARNING
      -------------------------------------------------------- */}
      {!isPaid && generationsLeft === 0 ? (
        <div className="bg-red-900/30 border border-red-500 rounded-lg p-4 mb-4">
          <p className="text-red-400 font-semibold">Daily limit reached!</p>
          <p className="text-sm text-gray-300 mt-1">
            You have used all {usageLimit} generations for today. Come back tomorrow or
            upgrade for unlimited generations!
          </p>
          <p className="text-xs text-gray-400 mt-2">
            {formatUtcResetTimeHint()}
          </p>
        </div>
      ) : null}

      {/* -------------------------------------------------------
          LOADING STATUS
      -------------------------------------------------------- */}
      {isLoading && (
        <>
          <div className="mt-2 flex items-center gap-3 rounded-lg border border-white/10 bg-white/5 px-4 py-3">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            <div className="text-sm text-white/80">
              {loadingMsg || "Creating lessons..."}
            </div>
          </div>
          <div className="mt-2 text-xs text-white/50">
            Large PDFs can take up to ~60 seconds.
          </div>
        </>
      )}

      {/* -------------------------------------------------------
          ACTIONS
      -------------------------------------------------------- */}
      <div className="flex gap-3 mt-4">
        <button
          onClick={handleSubmit}
          disabled={(!isPaid && generationsLeft === 0) || isLoading}
          className="flex-1 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-600 disabled:cursor-not-allowed px-6 py-3 rounded-lg font-semibold transition"
        >
          {isLoading ? "Generating..." : "Generate Lessons"}
        </button>

        <button
          onClick={onCancel}
          disabled={isLoading}
          className="px-6 py-3 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-700/60 disabled:cursor-not-allowed rounded-lg font-semibold transition"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
