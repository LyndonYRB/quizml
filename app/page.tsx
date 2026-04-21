// app/page.tsx
"use client";

/* =========================================================
   IMPORTS
========================================================= */

import { useState, useEffect, useMemo } from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

import FileUpload from "./components/FileUpload";
import AuthModal from "./components/AuthModal";

/* =========================================================
   PAGE COMPONENT
========================================================= */

export default function Home() {
  /* ---------------------------------------------------------
     STATE: Auth + UI
  --------------------------------------------------------- */

  const [showAuthModal, setShowAuthModal] = useState(false);
  const [user, setUser] = useState<User | null>(null);

  /* ---------------------------------------------------------
     CLIENTS
  --------------------------------------------------------- */

  const supabase = useMemo(() => createClient(), []);

  /* ---------------------------------------------------------
     EFFECT: Initialize auth + listen for changes
  --------------------------------------------------------- */

  useEffect(() => {
    // Initial user check
    supabase.auth.getUser().then(({ data: { user } }) => {
      setUser(user);
    });

    // Auth state listener (login / logout)
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, [supabase]);

  /* ---------------------------------------------------------
     HANDLERS
  --------------------------------------------------------- */

  const handleSignOut = async () => {
    await supabase.auth.signOut();
  };

  /* =========================================================
     RENDER
  ========================================================= */

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900">
      {/* =====================================================
         HEADER
      ===================================================== */}
      <header className="border-b border-gray-700">
        <div className="mx-auto max-w-7xl px-4 py-4 flex items-center justify-between">
          {/* Logo */}
          <h1 className="text-3xl font-bold text-white">
            Quiz<span className="text-blue-500">ML</span>.ai
          </h1>

          {/* Auth Controls */}
          <div className="flex gap-4 items-center">
            {user ? (
              <>
                <span className="text-gray-400 text-sm">{user.email}</span>
                <button
                  onClick={handleSignOut}
                  className="text-gray-400 hover:text-white transition"
                >
                  Sign Out
                </button>
              </>
            ) : (
              <button
                onClick={() => setShowAuthModal(true)}
                className="bg-blue-500 hover:bg-blue-600 px-6 py-2 rounded-lg font-semibold transition"
              >
                Sign In
              </button>
            )}
          </div>
        </div>
      </header>

      {/* =====================================================
         MAIN CONTENT
      ===================================================== */}
      <main className="mx-auto max-w-5xl px-4 py-12 sm:py-16">
        {/* ---------- Hero / Value Proposition ---------- */}
        <div className="text-center">
          <h2 className="animate-fade-up mx-auto max-w-3xl text-4xl sm:text-5xl font-extrabold tracking-tight text-white drop-shadow-sm">
            AI-powered microlearning from your study materials
          </h2>

          <p className="animate-fade-up-delay mx-auto mt-4 max-w-2xl text-base sm:text-xl text-white/80">
            Upload PDFs, get bite-sized lessons, ace your exams
          </p>

          {/* Subtle divider */}
          <div className="mx-auto mt-8 h-px w-40 bg-white/10" />
        </div>

        {/* ---------- Core App Area ---------- */}
        <div className="mt-10 sm:mt-12">
          <FileUpload
            isAuthed={!!user}
            userId={user?.id ?? null}
            onOpenAuth={() => setShowAuthModal(true)}
          />
        </div>
      </main>

      {/* =====================================================
         AUTH MODAL
      ===================================================== */}
      {showAuthModal && <AuthModal onClose={() => setShowAuthModal(false)} />}
    </div>
  );
}
