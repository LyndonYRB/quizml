// app/components/AuthModal.tsx
"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

/* =========================================================
   TYPES
========================================================= */

interface AuthModalProps {
  onClose: () => void;
}

/* =========================================================
   COMPONENT
========================================================= */

export default function AuthModal({ onClose }: AuthModalProps) {
  /* ---------------------------------------------------------
     STATE
  --------------------------------------------------------- */

  const [showEmail, setShowEmail] = useState(false);
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  /* ---------------------------------------------------------
     CLIENTS / CONFIG
  --------------------------------------------------------- */

  const supabase = createClient();

  const redirectTo =
    typeof window !== "undefined"
      ? `${window.location.origin}/auth/callback`
      : undefined;

  function validatePassword(value: string) {
    if (value.length < 8) {
      return "Password must be at least 8 characters.";
    }

    if (!/[A-Z]/.test(value)) {
      return "Password must include at least one uppercase letter.";
    }

    if (!/[a-z]/.test(value)) {
      return "Password must include at least one lowercase letter.";
    }

    if (!/[0-9]/.test(value)) {
      return "Password must include at least one number.";
    }

    if (!/[^A-Za-z0-9]/.test(value)) {
      return "Password must include at least one special character.";
    }

    return null;
  }

  /* ---------------------------------------------------------
     HANDLERS: OAUTH
  --------------------------------------------------------- */

  const signInWithGoogle = async () => {
    setLoading(true);
    setError("");

    try {
      // Sanity: env must exist on client
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (!url || !anon) {
        throw new Error(
          "Supabase env vars missing. Check .env.local and restart dev server."
        );
      }

      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo },
      });

      if (error) throw error;
      // OAuth redirects away; this usually will not hit onClose().
    } catch (err: unknown) {
      const msg =
        err instanceof Error && err.message === "Failed to fetch"
          ? "Network error reaching Supabase (maintenance, env, or blocker). Try again shortly."
          : err instanceof Error
          ? err.message
          : "Google sign-in failed";
      setError(msg);
      setLoading(false);
    }
  };

  /* ---------------------------------------------------------
     HANDLERS: EMAIL/PASSWORD
  --------------------------------------------------------- */

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const trimmedEmail = email.trim();

      if (isSignUp) {
        const passwordError = validatePassword(password);
        if (passwordError) {
          throw new Error(passwordError);
        }

        const { data, error } = await supabase.auth.signUp({
          email: trimmedEmail,
          password,
          options: { emailRedirectTo: redirectTo },
        });
        if (error) throw error;

        if (data.session) {
          onClose();
          return;
        }

        if (!data.user) {
          throw new Error("Sign-up did not complete. Please try again.");
        }

        alert("Check your email for the verification link!");
        onClose();
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: trimmedEmail,
          password,
        });
        if (error) throw error;
        onClose();
      }
    } catch (err: unknown) {
      const msg =
        err instanceof Error && err.message === "Failed to fetch"
          ? "Network error reaching Supabase (maintenance, env, or blocker). Use Google sign-in and/or retry later."
          : err instanceof Error
          ? err.message
          : "Authentication failed";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  /* =========================================================
     RENDER
  ========================================================= */

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-8 max-w-md w-full mx-4">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-bold">Sign in to QuizML.ai</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            x
          </button>
        </div>

        {/* -------------------------------------------------------
            GOOGLE OAUTH (PRIMARY)
        -------------------------------------------------------- */}
        <button
          type="button"
          onClick={signInWithGoogle}
          disabled={loading}
          className="w-full bg-white hover:bg-gray-100 disabled:bg-gray-300 text-black px-4 py-3 rounded-lg font-semibold transition"
        >
          {loading ? "Loading..." : "Continue with Google"}
        </button>

        <div className="my-4 flex items-center gap-3">
          <div className="h-px flex-1 bg-white/10" />
          <div className="text-xs text-gray-400">or</div>
          <div className="h-px flex-1 bg-white/10" />
        </div>

        {/* -------------------------------------------------------
            OPTIONAL EMAIL/PASSWORD
        -------------------------------------------------------- */}
        <button
          type="button"
          onClick={() => setShowEmail((v) => !v)}
          className="w-full border border-white/10 bg-white/5 hover:bg-white/10 px-4 py-3 rounded-lg font-semibold transition"
        >
          {showEmail ? "Hide email login" : "Use email & password (optional)"}
        </button>

        {showEmail && (
          <>
            <form onSubmit={handleEmailAuth} className="space-y-4 mt-4">
              <div>
                <label className="block text-sm text-gray-300 mb-2">
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 text-white"
                  placeholder="you@example.com"
                />
              </div>

              <div>
                <label className="block text-sm text-gray-300 mb-2">
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 text-white"
                  placeholder="password"
                />
                {isSignUp && (
                  <p className="mt-2 text-xs text-gray-400">
                    Use 8+ characters with uppercase, lowercase, number, and special character.
                  </p>
                )}
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-blue-500 hover:bg-blue-600 disabled:bg-gray-600 px-4 py-3 rounded-lg font-semibold transition"
              >
                {loading ? "Loading..." : isSignUp ? "Sign Up" : "Sign In"}
              </button>
            </form>

            <div className="mt-3 text-center">
              <button
                onClick={() => setIsSignUp(!isSignUp)}
                className="text-blue-400 hover:text-blue-300 text-sm"
              >
                {isSignUp
                  ? "Already have an account? Sign in"
                  : "Don't have an account? Sign up"}
              </button>
            </div>
          </>
        )}

        {/* -------------------------------------------------------
            ERROR
        -------------------------------------------------------- */}
        {error && (
          <div className="mt-4 bg-red-900/30 border border-red-500 rounded p-3">
            <p className="text-red-400 text-sm">{error}</p>
          </div>
        )}

        {/* -------------------------------------------------------
            FOOTNOTE
        -------------------------------------------------------- */}
        <p className="mt-4 text-xs text-gray-500">
          Note: If Supabase has scheduled maintenance, sign-in can temporarily
          fail.
        </p>
      </div>
    </div>
  );
}
