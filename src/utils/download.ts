// ─── File download ───

/** Saves generated text as a file through a temporary object URL. */
export function downloadTextFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoking synchronously cancels the download in Safari and some Firefox builds.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * A title reduced to characters that are safe in a file name. Letters and digits
 * of any script are kept, so "Zebranie zarządu" stays readable.
 */
export function fileSafeName(title: string): string {
  return title.replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '') || 'meeting';
}
