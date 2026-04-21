// app/auth/callback/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

/* =========================================================
   ROUTE: GET /auth/callback
========================================================= */

export async function GET(request: NextRequest) {
  /* ---------------------------------------------------------
     1) PARAM PARSING
  --------------------------------------------------------- */

  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const next = requestUrl.searchParams.get("next") ?? "/";

  /* ---------------------------------------------------------
     2) RESPONSE SETUP (for cookie attachment)
  --------------------------------------------------------- */

  const response = NextResponse.redirect(
    new URL(next, requestUrl.origin)
  );

  if (!code) return response;

  /* ---------------------------------------------------------
     3) ENV VALIDATION
  --------------------------------------------------------- */

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  if (!supabaseUrl || !supabaseAnonKey) {
    return NextResponse.redirect(
      new URL(
        `/?authError=1&reason=${encodeURIComponent(
          "Missing Supabase env vars"
        )}`,
        requestUrl.origin
      )
    );
  }

  /* ---------------------------------------------------------
     4) SUPABASE CLIENT (SSR cookie handling)
  --------------------------------------------------------- */

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  /* ---------------------------------------------------------
     5) OAUTH CODE EXCHANGE
  --------------------------------------------------------- */

  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error("OAuth exchange error:", error.message);
    return NextResponse.redirect(
      new URL(
        `/?authError=1&reason=${encodeURIComponent(error.message)}`,
        requestUrl.origin
      )
    );
  }

  /* ---------------------------------------------------------
     6) REDIRECT (session cookies attached)
  --------------------------------------------------------- */

  return response;
}
