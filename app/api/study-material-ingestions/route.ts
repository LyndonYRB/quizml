import { NextRequest, NextResponse } from "next/server";
import { createRouteClient } from "@/lib/supabase/server";

type StudyMaterialIngestionRow = {
  id: string;
  client_file_id: string | null;
  file_name: string;
  status: string;
  error_message: string | null;
  study_material_id: string | null;
  created_at: string;
  updated_at: string;
};

export async function GET(request: NextRequest) {
  const response = NextResponse.next();

  try {
    const supabase = createRouteClient(request, response);
    const { data: userData, error: userErr } = await supabase.auth.getUser();

    if (userErr || !userData?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const startedAfter = request.nextUrl.searchParams.get("startedAfter");
    const clientFileIds = request.nextUrl.searchParams.getAll("clientFileId");

    let query = supabase
      .from("study_material_ingestions")
      .select(
        "id, client_file_id, file_name, status, error_message, study_material_id, created_at, updated_at"
      )
      .eq("user_id", userData.user.id);

    if (startedAfter) {
      query = query.gte("created_at", startedAfter);
    }

    if (clientFileIds.length > 0) {
      query = query.in("client_file_id", clientFileIds);
    }

    const { data, error } = await query
      .order("created_at", { ascending: false })
      .returns<StudyMaterialIngestionRow[]>();

    if (error) {
      return NextResponse.json(
        { error: "Failed to load ingestion statuses." },
        { status: 500 }
      );
    }

    const latestByClientFileId = new Map<string, StudyMaterialIngestionRow>();
    for (const row of data ?? []) {
      if (row.client_file_id && !latestByClientFileId.has(row.client_file_id)) {
        latestByClientFileId.set(row.client_file_id, row);
      }
    }

    return NextResponse.json({
      success: true,
      ingestions: Array.from(latestByClientFileId.values()),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to load ingestion statuses: " + message },
      { status: 500 }
    );
  }
}
