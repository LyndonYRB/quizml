import type { SupabaseClient } from "@supabase/supabase-js";

const DEFAULT_STUDY_MATERIALS_BUCKET = "study-materials";
const SIGNED_URL_TTL_SECONDS = 60 * 60;

type StorageLocation = {
  bucket: string;
  path: string;
};

function sanitizeFileName(fileName: string) {
  const trimmed = fileName.trim();
  const fallback = "study-material.pdf";

  return (trimmed || fallback).replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function getStudyMaterialsBucket() {
  return process.env.SUPABASE_STUDY_MATERIALS_BUCKET || DEFAULT_STUDY_MATERIALS_BUCKET;
}

export function buildStoredFileReference(bucket: string, path: string) {
  return `storage://${bucket}/${path}`;
}

export function buildStudyMaterialStoragePath({
  userId,
  materialId,
  fileName,
}: {
  userId: string;
  materialId: string;
  fileName: string;
}) {
  return `${userId}/${materialId}/${sanitizeFileName(fileName)}`;
}

export async function uploadStudyMaterialFile({
  supabase,
  bucket,
  path,
  body,
  contentType,
  fileSize,
}: {
  supabase: SupabaseClient;
  bucket: string;
  path: string;
  body: Buffer;
  contentType?: string;
  fileSize?: number;
}) {
  console.log("study-material storage upload starting:", {
    bucket,
    path,
    fileSize: fileSize ?? null,
    bufferByteLength: body.byteLength,
  });

  if (body.byteLength <= 0) {
    throw new Error("Upload buffer is empty.");
  }

  const { data, error } = await supabase.storage.from(bucket).upload(path, body, {
    upsert: false,
    contentType: contentType || "application/pdf",
  });

  if (error) {
    throw new Error(error.message || "Failed to upload study material.");
  }

  if (!data?.path) {
    throw new Error("Storage upload did not return a file path.");
  }

  return data;
}

export async function deleteStoredStudyMaterialFile({
  supabase,
  storedFileUrl,
}: {
  supabase: SupabaseClient;
  storedFileUrl?: string | null;
}) {
  const location = parseStoredFileReference(storedFileUrl);
  if (!location) return;

  const { error } = await supabase.storage.from(location.bucket).remove([location.path]);
  if (error) {
    console.error("study-material storage cleanup failed:", {
      storedFileUrl,
      message: error.message,
    });
  }
}

export async function downloadStoredStudyMaterialFile({
  supabase,
  storedFileUrl,
}: {
  supabase: SupabaseClient;
  storedFileUrl?: string | null;
}) {
  const location = parseStoredFileReference(storedFileUrl);
  if (!location) {
    throw new Error("Stored file reference is missing or invalid.");
  }

  const { data, error } = await supabase.storage
    .from(location.bucket)
    .download(location.path);

  if (error || !data) {
    throw new Error(error?.message || "Failed to download stored study material.");
  }

  const arrayBuffer = await data.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.byteLength <= 0) {
    throw new Error("Downloaded study material is empty.");
  }

  return {
    buffer,
    bucket: location.bucket,
    path: location.path,
  };
}

function parseStoredFileReference(storedFileUrl?: string | null): StorageLocation | null {
  if (!storedFileUrl || !storedFileUrl.startsWith("storage://")) {
    return null;
  }

  const withoutProtocol = storedFileUrl.slice("storage://".length);
  const slashIndex = withoutProtocol.indexOf("/");
  if (slashIndex <= 0) return null;

  const bucket = withoutProtocol.slice(0, slashIndex);
  const path = withoutProtocol.slice(slashIndex + 1);
  if (!bucket || !path) return null;

  return { bucket, path };
}

function isAbsoluteHttpUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

function isLegacyStudyMaterialRoute(value: string) {
  return /^\/?\?studyMaterialId=/i.test(value);
}

export async function resolveStudyMaterialOpenUrl({
  supabase,
  storedFileUrl,
}: {
  supabase: SupabaseClient;
  storedFileUrl?: string | null;
}) {
  if (!storedFileUrl) {
    return { openUrl: null, fileAvailable: false };
  }

  if (isLegacyStudyMaterialRoute(storedFileUrl)) {
    return { openUrl: null, fileAvailable: false };
  }

  const storageLocation = parseStoredFileReference(storedFileUrl);
  if (storageLocation) {
    const { data, error } = await supabase.storage
      .from(storageLocation.bucket)
      .createSignedUrl(storageLocation.path, SIGNED_URL_TTL_SECONDS);

    if (error || !data?.signedUrl) {
      return { openUrl: null, fileAvailable: false };
    }

    return { openUrl: data.signedUrl, fileAvailable: true };
  }

  if (isAbsoluteHttpUrl(storedFileUrl)) {
    return { openUrl: storedFileUrl, fileAvailable: true };
  }

  return { openUrl: null, fileAvailable: false };
}
