import { NextRequest, NextResponse } from "next/server";
import {
  createIngestionRecord,
  failIngestionBatch,
  type StudyMaterialIngestionJobPayload,
  type StudyMaterialIngestionRow,
} from "@/lib/ingestion-processor";
import {
  buildStoredFileReference,
  buildStudyMaterialStoragePath,
  deleteStoredStudyMaterialFile,
  getStudyMaterialsBucket,
  uploadStudyMaterialFile,
} from "@/lib/study-material-storage";
import { getStudyMaterialIngestionQueue } from "@/lib/queue";
import {
  createRouteClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";

const MAX_PDF_BYTES_FREE = 10 * 1024 * 1024;
const MAX_PDF_BYTES_PAID = 50 * 1024 * 1024;

type UploadedStorageTarget = {
  fileName: string;
  storedFileUrl: string;
};

export async function POST(request: NextRequest) {
  const response = NextResponse.next();

  try {
    const supabase = createRouteClient(request, response);
    const supabaseAdmin = createServiceRoleClient();
    const { data: userData, error: userErr } = await supabase.auth.getUser();

    if (userErr || !userData?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = userData.user.id;
    const { data: profile } = await supabase
      .from("profiles")
      .select("is_paid")
      .eq("user_id", userId)
      .maybeSingle();

    const isPaid = !!profile?.is_paid;
    const formData = await request.formData();
    const uploadedFiles = formData.getAll("files");

    if (uploadedFiles.length === 0) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    if (!isPaid && uploadedFiles.length !== 1) {
      return NextResponse.json(
        { error: "Free plan supports one PDF at a time." },
        { status: 400 }
      );
    }

    if (uploadedFiles.some((file) => !(file instanceof File))) {
      return NextResponse.json({ error: "Invalid file upload." }, { status: 400 });
    }

    const files = uploadedFiles as File[];
    const clientFileIds = formData.getAll("client_file_id");
    const maxSize = isPaid ? MAX_PDF_BYTES_PAID : MAX_PDF_BYTES_FREE;

    const oversizedFile = files.find((file) => file.size > maxSize);
    if (oversizedFile) {
      return NextResponse.json(
        {
          error: `${oversizedFile.name} is too large (max ${
            maxSize / 1024 / 1024
          }MB).`,
        },
        { status: 413 }
      );
    }

    const nonPdfFile = files.find(
      (file) => file.type && file.type !== "application/pdf"
    );
    if (nonPdfFile) {
      return NextResponse.json(
        { error: "Only PDF files are supported." },
        { status: 415 }
      );
    }

    if (clientFileIds.length > 0 && clientFileIds.length !== files.length) {
      return NextResponse.json(
        { error: "Each uploaded file must include a matching client file id." },
        { status: 400 }
      );
    }

    const ingestionOrder: StudyMaterialIngestionRow[] = [];
    const uploadedStorageTargets: UploadedStorageTarget[] = [];
    const studyMaterialsBucket = getStudyMaterialsBucket();

    for (const [index, file] of files.entries()) {
      const clientFileIdValue = clientFileIds[index];
      const clientFileId =
        typeof clientFileIdValue === "string" && clientFileIdValue.trim()
          ? clientFileIdValue.trim()
          : null;

      if (!clientFileId) {
        const message = `Missing client file id for ${file.name}.`;
        await failIngestionBatch({
          supabaseAdmin,
          ingestionRecords: ingestionOrder,
          currentMessage: message,
        });
        return NextResponse.json({ error: message }, { status: 400 });
      }

      try {
        const ingestion = await createIngestionRecord({
          supabaseAdmin,
          userId,
          clientFileId,
          fileName: file.name,
        });
        ingestionOrder.push(ingestion);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : `Failed to create ingestion record for ${file.name}.`;
        console.error("ingest-materials ingestion record create failed:", {
          fileName: file.name,
          message,
        });
        await failIngestionBatch({
          supabaseAdmin,
          ingestionRecords: ingestionOrder,
          currentMessage: message,
        });
        return NextResponse.json({ success: false, error: message }, { status: 500 });
      }
    }

    let payloadFiles: StudyMaterialIngestionJobPayload["files"];
    try {
      payloadFiles = await Promise.all(
        files.map(async (file, index) => {
          const clientFileId = String(clientFileIds[index]).trim();
          const materialId = crypto.randomUUID();
          const storagePath = buildStudyMaterialStoragePath({
            userId,
            materialId,
            fileName: file.name,
          });
          const storedFileUrl = buildStoredFileReference(
            studyMaterialsBucket,
            storagePath
          );

          const arrayBuffer = await file.arrayBuffer();
          const fileBuffer = Buffer.from(arrayBuffer);

          if (fileBuffer.byteLength <= 0) {
            throw new Error(`${file.name} is empty and could not be uploaded.`);
          }

          await uploadStudyMaterialFile({
            supabase: supabaseAdmin,
            bucket: studyMaterialsBucket,
            path: storagePath,
            body: fileBuffer,
            contentType: file.type || "application/pdf",
            fileSize: file.size,
          });

          uploadedStorageTargets.push({
            fileName: file.name,
            storedFileUrl,
          });

          return {
            clientFileId,
            fileName: file.name,
            materialId,
            storagePath,
            storedFileUrl,
          };
        })
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not upload PDFs for background processing.";
      for (const target of uploadedStorageTargets) {
        await deleteStoredStudyMaterialFile({
          supabase: supabaseAdmin,
          storedFileUrl: target.storedFileUrl,
        });
      }
      await failIngestionBatch({
        supabaseAdmin,
        ingestionRecords: ingestionOrder,
        currentMessage: message,
      });
      return NextResponse.json({ success: false, error: message }, { status: 400 });
    }

    try {
      const queue = getStudyMaterialIngestionQueue();
      await queue.add("ingest-study-materials", {
        userId,
        files: payloadFiles,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to enqueue study material ingestion job.";
      console.error("ingest-materials queue enqueue failed:", {
        userId,
        message,
      });
      for (const target of uploadedStorageTargets) {
        await deleteStoredStudyMaterialFile({
          supabase: supabaseAdmin,
          storedFileUrl: target.storedFileUrl,
        });
      }
      await failIngestionBatch({
        supabaseAdmin,
        ingestionRecords: ingestionOrder,
        currentMessage: message,
      });
      return NextResponse.json({ success: false, error: message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      enqueued: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("ingest-materials route error:", message);
    return NextResponse.json(
      { error: "Failed to enqueue study materials: " + message },
      { status: 500 }
    );
  }
}
