// The brand's one illustration. A voice, handed across, arrives as a
// written record: the waveform leaves the left hand, travels the arm,
// becomes transcript lines in the right hand.
//
// Inlined as JSX rather than an <img> so GSAP can reach .cr-ribbon-path and
// the hand groups directly. Do not delete the untransformed wrapper <g>
// around each positioned <g> (.cr-hand-a, .cr-hand-b, .cr-cargo-in,
// .cr-cargo-out). Tweening x/y on a group that already carries its own
// transform="translate(...)" snaps it to the wrong position, since GSAP
// parses that transform as its starting baseline. The wrapper is the fix,
// and it looks redundant in JSX. It is not. See the implementation spec's
// GSAP appendix, "The SVG transform gotcha".
//
// On product surfaces (dashboard empty state, "Transcribing" illustration),
// render at scale 0.4 or smaller and never wire the draw animation. Draw is
// a marketing-only, first-time moment.
export default function HandoffRibbon({ className, scale = 1, style }) {
  return (
    <svg
      viewBox="-20 -25 1240 340"
      className={className}
      role="img"
      aria-labelledby="cr-ribbon-title cr-ribbon-desc"
      style={scale !== 1 ? { transform: `scale(${scale})`, transformOrigin: 'center', ...style } : style}
    >
      <title id="cr-ribbon-title">A voice handed across and returned as a written record</title>
      <desc id="cr-ribbon-desc">
        One long ribbon arm carries a waveform from a hand on the left to a hand on the right, where it has become a page of transcript lines.
      </desc>

      <path
        className="cr-ribbon-path"
        d="M120,260 C260,260 300,60 480,60 C640,60 640,260 800,260 C920,260 960,90 1090,90"
        fill="none"
        stroke="var(--cr-red, #E63946)"
        strokeWidth={34}
        strokeLinecap="round"
      />

      <g className="cr-hand-a">
        <g fill="var(--cr-paper, #F4F1EA)" transform="translate(58,196)">
          <rect x="-8" y="66" width="36" height="16" rx="8" transform="rotate(-22 5 74)" />
          <rect x="6" y="30" width="70" height="46" rx="23" />
          <rect x="6" y="2" width="14" height="56" rx="7" transform="rotate(-10 13 30)" />
          <rect x="22" y="-8" width="14" height="66" rx="7" />
          <rect x="38" y="-2" width="14" height="60" rx="7" transform="rotate(7 45 28)" />
          <rect x="54" y="6" width="12" height="52" rx="6" transform="rotate(16 60 32)" />
        </g>
      </g>

      <g className="cr-cargo-in">
        <g transform="translate(78,150)">
          <rect x="0" y="0" width="56" height="42" rx="6" fill="var(--cr-ink, #0E0E0F)" />
          <rect x="8" y="16" width="4" height="14" fill="var(--cr-yellow, #FFD23F)" />
          <rect x="16" y="9" width="4" height="26" fill="var(--cr-yellow, #FFD23F)" />
          <rect x="24" y="17" width="4" height="10" fill="var(--cr-yellow, #FFD23F)" />
          <rect x="32" y="5" width="4" height="34" fill="var(--cr-yellow, #FFD23F)" />
          <rect x="40" y="13" width="4" height="18" fill="var(--cr-yellow, #FFD23F)" />
        </g>
      </g>

      <g className="cr-hand-b">
        <g fill="var(--cr-paper, #F4F1EA)" transform="translate(1148,26) scale(-1,1)">
          <rect x="-8" y="66" width="36" height="16" rx="8" transform="rotate(-22 5 74)" />
          <rect x="6" y="30" width="70" height="46" rx="23" />
          <rect x="6" y="2" width="14" height="56" rx="7" transform="rotate(-10 13 30)" />
          <rect x="22" y="-8" width="14" height="66" rx="7" />
          <rect x="38" y="-2" width="14" height="60" rx="7" transform="rotate(7 45 28)" />
          <rect x="54" y="6" width="12" height="52" rx="6" transform="rotate(16 60 32)" />
        </g>
      </g>

      <g className="cr-cargo-out">
        <g transform="translate(978,-14)">
          <rect x="0" y="0" width="72" height="50" rx="6" fill="var(--cr-paper, #F4F1EA)" />
          <rect x="9" y="11" width="42" height="4" rx="2" fill="var(--cr-ink, #0E0E0F)" />
          <rect x="9" y="21" width="54" height="4" rx="2" fill="var(--cr-ink, #0E0E0F)" opacity={0.55} />
          <rect x="9" y="31" width="32" height="4" rx="2" fill="var(--cr-ink, #0E0E0F)" opacity={0.55} />
        </g>
      </g>
    </svg>
  );
}
