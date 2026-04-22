import { RAG_CONFIG } from "@/lib/rag-config";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt: number) {
  const jitter = Math.floor(Math.random() * 150);
  return RAG_CONFIG.openAiBaseDelayMs * 2 ** (attempt - 1) + jitter;
}

function isRetryableOpenAIError(error: unknown) {
  if (!error || typeof error !== "object") return false;

  const status = "status" in error ? Number(error.status) : 0;
  const code = "code" in error ? String(error.code) : "";

  return (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status >= 500 ||
    code === "rate_limit_exceeded" ||
    code === "server_error"
  );
}

export async function withOpenAIRetry<T>(
  label: string,
  operation: () => Promise<T>
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= RAG_CONFIG.openAiMaxRetries + 1; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (
        attempt > RAG_CONFIG.openAiMaxRetries ||
        !isRetryableOpenAIError(error)
      ) {
        throw error;
      }

      console.warn(`${label} retrying after transient OpenAI error`, {
        attempt,
        message: error instanceof Error ? error.message : "Unknown error",
      });

      await sleep(retryDelayMs(attempt));
    }
  }

  throw lastError;
}
