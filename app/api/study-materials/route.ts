import { NextRequest, NextResponse } from "next/server";
import {
  createRouteClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";
import { resolveStudyMaterialOpenUrl } from "@/lib/study-material-storage";

type StudyMaterialRow = {
  id: string;
  file_name: string;
  file_url: string;
  created_at: string;
};

type StudyMaterialResponseRow = StudyMaterialRow & {
  open_url: string | null;
  file_available: boolean;
};

export async function GET(request: NextRequest) {
  const response = NextResponse.next();

  try {
    const supabase = createRouteClient(request, response);
    const supabaseAdmin = createServiceRoleClient();
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

    const studyMaterials: StudyMaterialResponseRow[] = await Promise.all(
      (data ?? []).map(async (material) => {
        const { openUrl, fileAvailable } = await resolveStudyMaterialOpenUrl({
          supabase: supabaseAdmin,
          storedFileUrl: material.file_url,
        });

        return {
          ...material,
          open_url: openUrl,
          file_available: fileAvailable,
        };
      })
    );

    return NextResponse.json({
      success: true,
      studyMaterials,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to load study materials: " + message },
      { status: 500 }
    );
  }
}
