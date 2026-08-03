/**
 * Chain-link glyph (font-awesome-esque "link" / "link-horizontal-slash"),
 * stroked in currentColor so the CSS status classes pick the hue. Used for
 * connectivity: the topbar's room connection and each tray's presence.
 */
export function LinkIcon({ slashed = false, size = 16 }: { slashed?: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M9 8H7a4 4 0 0 0 0 8h2" />
      <path d="M15 16h2a4 4 0 0 0 0-8h-2" />
      <line x1="9" y1="12" x2="15" y2="12" />
      {slashed && <line x1="3.5" y1="3.5" x2="20.5" y2="20.5" />}
    </svg>
  );
}
