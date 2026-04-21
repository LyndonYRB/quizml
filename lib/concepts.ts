export function normalizeConcept(concept: string): string {
  const normalized = concept
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

  const words = normalized.split(" ");
  const last = words[words.length - 1];

  const singularLast = normalizePlural(last);
  words[words.length - 1] = singularLast;

  return words.join(" ");
}

function normalizePlural(word: string): string {
  if (word.length <= 3) {
    return word;
  }

  if (word.endsWith("ies")) {
    return word.slice(0, -3) + "y";
  }

  if (word.endsWith("ss")) {
    return word;
  }

  if (word.endsWith("s")) {
    return word.slice(0, -1);
  }

  return word;
}
