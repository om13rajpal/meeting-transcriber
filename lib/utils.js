import { clsx } from "clsx";
import { twMerge } from "tailwind-merge"

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

// Wraps every case-insensitive occurrence of `query` in `text` with a
// <mark>, as an array of strings/elements - never dangerouslySetInnerHTML,
// since `text` can be user- or transcript-sourced. Used by the dashboard's
// search preview and the meeting page's jump-to-match highlighting.
export function highlightText(text, query) {
  const trimmed = typeof query === "string" ? query.trim() : "";
  if (!trimmed || !text) return text;

  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = String(text).split(new RegExp(`(${escaped})`, "gi"));
  const lowerQuery = trimmed.toLowerCase();

  return parts.map((part, i) =>
    part.toLowerCase() === lowerQuery
      ? (
        // Yellow is the search-match highlighter and nothing else in this
        // system, see app/globals.css. Never bg-primary, that is the brand
        // red and reserved for the primary action, the focus ring, and
        // the Failed status.
        <mark key={i} className="rounded-[var(--cr-radius-sm)] px-0.5 bg-[var(--cr-yellow)] text-[var(--cr-yellow-ink)]">{part}</mark>
      )
      : part
  );
}
