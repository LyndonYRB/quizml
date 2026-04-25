import { NextRequest, NextResponse } from "next/server";
import {
  createRouteClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";
import {
  deleteStoredStudyMaterialFile,
  resolveStudyMaterialOpenUrl,
} from "@/lib/study-material-storage";

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

type DeleteStudyMaterialRequest = {
  materialId?: unknown;
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

export async function DELETE(request: NextRequest) {
  const response = NextResponse.next();

  try {
    const supabase = createRouteClient(request, response);
    const supabaseAdmin = createServiceRoleClient();
    const { data: userData, error: userErr } = await supabase.auth.getUser();

    if (userErr || !userData?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as DeleteStudyMaterialRequest;
    const materialId =
      typeof body.materialId === "string" ? body.materialId.trim() : "";

    if (!materialId) {
      return NextResponse.json(
        { error: "A study material id is required." },
        { status: 400 }
      );
    }

    const { data: material, error: materialErr } = await supabaseAdmin
      .from("study_materials")
      .select("id, user_id, file_name, file_url")
      .eq("id", materialId)
      .maybeSingle<StudyMaterialRow & { user_id: string }>();

    if (materialErr) {
      return NextResponse.json(
        { error: "Failed to load the study material." },
        { status: 500 }
      );
    }

    if (!material || material.user_id !== userData.user.id) {
      return NextResponse.json(
        { error: "Study material not found." },
        { status: 404 }
      );
    }

    const { error: lessonRunMaterialErr } = await supabaseAdmin
      .from("lesson_run_materials")
      .delete()
      .eq("study_material_id", material.id);

    if (lessonRunMaterialErr) {
      console.error("study-material delete lesson_run_materials failed:", {
        materialId: material.id,
        message: lessonRunMaterialErr.message,
      });
      return NextResponse.json(
        { error: "Failed to remove lesson links for the study material." },
        { status: 500 }
      );
    }

    const { error: chunksErr } = await supabaseAdmin
      .from("study_material_chunks")
      .delete()
      .eq("study_material_id", material.id);

    if (chunksErr) {
      console.error("study-material delete study_material_chunks failed:", {
        materialId: material.id,
        message: chunksErr.message,
      });
      return NextResponse.json(
        { error: "Failed to remove stored chunks for the study material." },
        { status: 500 }
      );
    }

    const { error: materialDeleteErr } = await supabaseAdmin
      .from("study_materials")
      .delete()
      .eq("id", material.id);

    if (materialDeleteErr) {
      console.error("study-material delete study_materials failed:", {
        materialId: material.id,
        message: materialDeleteErr.message,
      });
      return NextResponse.json(
        { error: "Failed to delete the study material." },
        { status: 500 }
      );
    }

    await deleteStoredStudyMaterialFile({
      supabase: supabaseAdmin,
      storedFileUrl: material.file_url,
    });

    return NextResponse.json({
      success: true,
      deletedMaterialId: material.id,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to delete study material: " + message },
      { status: 500 }
    );
  }
}
