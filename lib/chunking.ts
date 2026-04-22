const DEFAULT_TARGET_CHARS = 1200;
const DEFAULT_OVERLAP_CHARS = 180;

export type TextChunk = {
  chunkIndex: number;
  content: string;
  tokenCount: number;
};

export function normalizeExtractedText(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function estimateTokenCount(text: string) {
  return Math.ceil(text.trim().length / 4);
}

function splitOversizedBlock(block: string, targetChars: number) {
  const parts: string[] = [];
  for (let start = 0; start < block.length; start += targetChars) {
    const part = block.slice(start, start + targetChars).trim();
    if (part) parts.push(part);
  }
  return parts;
}

export function splitTextIntoChunks(
  text: string,
  options: { targetChars?: number; overlapChars?: number } = {}
): TextChunk[] {
  const targetChars = options.targetChars ?? DEFAULT_TARGET_CHARS;
  const overlapChars = options.overlapChars ?? DEFAULT_OVERLAP_CHARS;
  const normalized = normalizeExtractedText(text);
  if (!normalized) return [];

  const paragraphBlocks = normalized
    .split(/\n\s*\n/)
    .flatMap((block) => {
      const trimmed = block.trim();
      if (!trimmed) return [];
      if (trimmed.length <= targetChars * 1.4) return [trimmed];
      return splitOversizedBlock(trimmed, targetChars);
    });

  const chunks: string[] = [];
  let current = "";
  let previousTail = "";

  for (const block of paragraphBlocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= targetChars || !current) {
      current = candidate;
      continue;
    }

    chunks.push(current.trim());
    previousTail = current.slice(Math.max(0, current.length - overlapChars)).trim();
    current = previousTail ? `${previousTail}\n\n${block}` : block;
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks
    .map((content, index) => ({
      chunkIndex: index,
      content,
      tokenCount: estimateTokenCount(content),
    }))
    .filter((chunk) => chunk.content.length > 0);
}
