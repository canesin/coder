function chunkPointers(text, { maxChars = 12000, maxChunks = 24 } = {}) {
  const normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!normalized) return [];

  const chunks = [];
  let cursor = 0;
  while (cursor < normalized.length && chunks.length < maxChunks) {
    let end = Math.min(cursor + maxChars, normalized.length);
    if (end < normalized.length) {
      const newlineBoundary = normalized.lastIndexOf("\n", end);
      if (newlineBoundary > cursor + Math.floor(maxChars * 0.5)) {
        end = newlineBoundary;
      }
    }
    
    // THE PROPOSED GUARD
    if (end <= cursor) {
      end = Math.min(cursor + (maxChars > 0 ? maxChars : 1), normalized.length);
    }
    
    const chunk = normalized.slice(cursor, end).trim();
    if (chunk) chunks.push(chunk);
    cursor = end;
  }

  if (cursor < normalized.length && chunks.length > 0) {
    const omitted = normalized.length - cursor;
    chunks[chunks.length - 1] +=
      `\n\n[TRUNCATED: ${omitted} chars omitted due to chunk limit]`;
  }

  return chunks;
}

console.log(chunkPointers("hello\nworld", { maxChars: 0 }));
