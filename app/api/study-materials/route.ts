import { NextRequest, NextResponse } from "next/server";
import { createRouteClient } from "@/lib/supabase/server";

type StudyMaterialRow = {
  id: string;
  file_name: string;
  file_url: string;
  created_at: string;
};

export async function GET(request: NextRequest) {
  const response = NextResponse.next();

  try {
    const supabase = createRouteClient(request, response);
    const { data: userData, error: userErr } = await supabase.auth.getUser();

    if (userErr || !userData?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data, error } = await supabase
      .from("study_materials")
      .select("id, file_name, file_url, created_at")
      .eq("user_id", userData.user.id)
      .order("created_at", { ascending: false })
      .returns<StudyMaterialRow[]>();

    if (error) {
      return NextResponse.json(
        { error: "Failed to load study materials." },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      studyMaterials: data ?? [],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to load study materials: " + message },
      { status: 500 }
    );
  }
}
