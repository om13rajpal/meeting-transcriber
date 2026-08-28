/* @moodforge
schema: 1.0
round: 3
phase: brand-kit
worker: moodforge-brand-architect
theme: court-reporter
version: v1
created_at: 2026-08-28T00:00:00Z
sha256: f83c8913f7febe9fa8a1179ae6c422ee846c1ccc87e3382ed4060ed06a9975b5
artifact_role: tokens
exports: [colors, contrast, type, typeScale, spacing, stroke, ruleTone, lineWeight, radius, motion, surfaceSplit, shadcnSlots]
summary: Court Reporter typed token export. Mirrors tokens.css exactly. Reference and tooling artifact only, the app itself is JavaScript and integrates via tokens.css.
*/

/**
 * COURT REPORTER · design tokens · v1
 *
 * READ THIS BEFORE IMPORTING.
 *
 * The meeting-transcriber app is JavaScript, not TypeScript, and its
 * CLAUDE.md forbids introducing .ts/.tsx files into app source. This file
 * is a design-system artifact: it exists so Style Dictionary, Figma token
 * plugins, and design tooling have a typed source of truth, and so a human
 * reading one file can see every value the system contains.
 *
 * The app's real integration path is tokens.css merged into
 * app/globals.css. Do not add an import of this file to app/ or backend/.
 */

/* ── colors ──────────────────────────────────────────────────────────── */

export const colors = {
  // neutrals · dark side
  ink: '#0E0E0F',
  inkSunken: '#08080A',
  inkApp: '#111113',
  inkRaised: '#141417',
  inkHover: '#1A1A1D',
  rule: '#1C1C1C',
  ruleSoft: '#232327',
  ruleStrong: '#2A2A2E',

  // neutrals · paper side
  paper: '#F4F1EA',
  paperLifted: '#FBF9F4',
  paperDim: '#EDEAE3',
  paperRule: '#D8D3C6',

  // text tiers. Nothing dimmer than textMuted is legal as text on dark.
  text: '#F4F1EA',
  textSecondary: '#C9C6BD',
  textTertiary: '#A8A49B',
  textMuted: '#8A8A86',
  textOnPaper: '#0E0E0F',
  textPaperMuted: '#66625A',

  // decoration only. 3.43:1 on ink. Never assign this to a text color.
  hairline: '#6B675F',

  // stamp red. One red, three jobs, chosen by what sits behind it.
  red: '#E63946',
  redText: '#EC4B57',
  redFill: '#B8202D',
  redFillHover: '#C82232',
  redFillPress: '#A81B27',

  // highlighter yellow. A background, not a text color (except on dark).
  yellow: '#FFD23F',
  yellowInk: '#0E0E0F',

  // semantic
  success: '#6FCF97',
  warning: '#FFD23F',
  danger: '#EC4B57',

  // precomputed status chip fills (composites, not rgba)
  tintRed: '#2C1417',
  tintYellow: '#2B2615',
  tintGreen: '#1C2922',
} as const;

export type ColorToken = keyof typeof colors;

/* ── contrast ────────────────────────────────────────────────────────── */

/**
 * Every real text-on-background pairing this system ships, with its measured
 * WCAG 2.1 ratio. `aaBody` is >= 4.5:1. `aaLarge` is >= 3:1 and only applies
 * at 24px, or 18.66px at weight 700 and above.
 *
 * If a pairing is not in this list, it has not been verified. Verify it or
 * do not ship it.
 */
export const contrast = [
  { fg: 'text', bg: 'ink', ratio: 17.11, aaBody: true, aaLarge: true },
  { fg: 'textSecondary', bg: 'ink', ratio: 11.3, aaBody: true, aaLarge: true },
  { fg: 'textTertiary', bg: 'ink', ratio: 7.76, aaBody: true, aaLarge: true },
  { fg: 'textTertiary', bg: 'inkRaised', ratio: 7.4, aaBody: true, aaLarge: true },
  { fg: 'textMuted', bg: 'ink', ratio: 5.57, aaBody: true, aaLarge: true },
  { fg: 'textMuted', bg: 'inkApp', ratio: 5.44, aaBody: true, aaLarge: true },
  { fg: 'textMuted', bg: 'inkRaised', ratio: 5.31, aaBody: true, aaLarge: true },
  { fg: 'text', bg: 'inkRaised', ratio: 16.3, aaBody: true, aaLarge: true },
  { fg: 'red', bg: 'ink', ratio: 4.63, aaBody: true, aaLarge: true },
  { fg: 'redText', bg: 'ink', ratio: 5.25, aaBody: true, aaLarge: true },
  { fg: 'redText', bg: 'inkRaised', ratio: 5.0, aaBody: true, aaLarge: true },
  { fg: 'redText', bg: 'tintRed', ratio: 4.68, aaBody: true, aaLarge: true },
  { fg: 'yellow', bg: 'ink', ratio: 13.36, aaBody: true, aaLarge: true },
  { fg: 'yellow', bg: 'tintYellow', ratio: 10.46, aaBody: true, aaLarge: true },
  { fg: 'success', bg: 'ink', ratio: 10.15, aaBody: true, aaLarge: true },
  { fg: 'success', bg: 'tintGreen', ratio: 7.95, aaBody: true, aaLarge: true },
  { fg: 'textOnPaper', bg: 'paper', ratio: 17.11, aaBody: true, aaLarge: true },
  { fg: 'textPaperMuted', bg: 'paper', ratio: 5.38, aaBody: true, aaLarge: true },
  { fg: 'redFill', bg: 'paper', ratio: 5.67, aaBody: true, aaLarge: true },
  { fg: 'paper', bg: 'redFill', ratio: 5.67, aaBody: true, aaLarge: true },
  { fg: 'paper', bg: 'redFillHover', ratio: 4.99, aaBody: true, aaLarge: true },
  { fg: 'paper', bg: 'redFillPress', ratio: 6.53, aaBody: true, aaLarge: true },
  { fg: 'yellowInk', bg: 'yellow', ratio: 13.36, aaBody: true, aaLarge: true },
  { fg: 'ink', bg: 'success', ratio: 10.15, aaBody: true, aaLarge: true },
] as const;

/**
 * Pairings that were tested and REJECTED. Each one names the token to reach
 * for instead. These are enforced by review, not by the type system, so read
 * them.
 */
export const contrastRejected = [
  { fg: 'paper', bg: 'red', ratio: 3.7, use: 'redFill as the surface instead (5.67:1)' },
  { fg: 'red', bg: 'paper', ratio: 3.7, use: 'redFill as the text color instead (5.67:1)' },
  { fg: 'red', bg: 'inkRaised', ratio: 4.41, use: 'redText instead (5.00:1)' },
  { fg: 'red', bg: 'tintRed', ratio: 4.13, use: 'redText instead (4.68:1)' },
  { fg: 'hairline', bg: 'ink', ratio: 3.43, use: 'textMuted instead (5.57:1). hairline is decoration only' },
  { fg: 'yellow', bg: 'paper', ratio: 1.28, use: 'never. yellow is a background on paper, never a text color' },
  { fg: 'redFill', bg: 'ink', ratio: 3.02, use: 'redText instead. never use text-primary on dark' },
] as const;

/* ── type ────────────────────────────────────────────────────────────── */

export const fonts = {
  display: "'Big Shoulders Display', 'Arial Narrow', system-ui, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, 'SFMono-Regular', monospace",
  body: "var(--font-geist-sans, 'Inter'), system-ui, sans-serif",
} as const;

/** The full ladder, largest to smallest. Every size in the system is here. */
export const typeScale = [180, 84, 48, 30, 22, 17, 15, 13, 12, 11, 10] as const;

export const type = {
  cover: { family: fonts.display, weight: 900, size: 180, leading: 0.9, tracking: '-0.02em', transform: 'uppercase' },
  display: { family: fonts.display, weight: 900, size: 84, leading: 0.92, tracking: '-0.01em', transform: 'uppercase', clampFrom: 46 },
  h1: { family: fonts.display, weight: 900, size: 48, leading: 0.95, tracking: '-0.01em', transform: 'uppercase' },
  h2: { family: fonts.display, weight: 800, size: 30, leading: 1.0, tracking: '0.01em', transform: 'uppercase' },
  h3: { family: fonts.display, weight: 800, size: 22, leading: 1.1, tracking: '0.02em', transform: 'uppercase' },
  lede: { family: fonts.body, weight: 400, size: 17, leading: 1.65, tracking: '0' },
  body: { family: fonts.body, weight: 400, size: 15, leading: 1.6, tracking: '0' },
  sm: { family: fonts.body, weight: 400, size: 13, leading: 1.5, tracking: '0' },
  transcript: { family: fonts.mono, weight: 400, size: 13, leading: 1.9, tracking: '0' },
  mono: { family: fonts.mono, weight: 500, size: 12, leading: 1.4, tracking: '0.16em', transform: 'uppercase' },
  meta: { family: fonts.mono, weight: 400, size: 11, leading: 1.4, tracking: '0.02em' },
  tiny: { family: fonts.mono, weight: 600, size: 10, leading: 1.2, tracking: '0.08em', transform: 'uppercase' },
} as const;

export type TypeToken = keyof typeof type;

/* ── layout ──────────────────────────────────────────────────────────── */

export const spacing = [4, 8, 12, 16, 24, 32, 40, 56, 88, 120] as const;

export const measure = {
  marketing: 1180,
  app: 1040,
  read: 460,
} as const;

export const breakpoints = {
  sm: 560,
  md: 860,
  lg: 940,
  xl: 1180,
} as const;

/**
 * THE BORDER SCALE IS ONE VALUE.
 *
 * Emphasis is carried by the rule's COLOUR, never by its weight. A quiet
 * divider and a structural edge are the same hairline in two different
 * colours, which is how a printed page does it. Reach for `colors.ruleSoft`,
 * `colors.ruleStrong`, `colors.paper` or `colors.red` to change how loud a
 * rule is. Never change its width.
 *
 * History, so this does not get undone:
 * v1 shipped `emph` (2) and `stamp` (2.5) and the system read as a stack of
 * thick bordered boxes. Both were removed. A 1.5 middle tier was then tried
 * and also removed, for a concrete reason: Blink FLOORS sub-pixel border
 * widths, so `border: 1.5px` computes and paints as `1px` in Chrome at any
 * devicePixelRatio, while Safari and Firefox honour it. A tier that only
 * exists in two of three engines is not a tier, it is an inconsistency.
 *
 * If a box feels like it needs more weight than a hairline, it does not need
 * a heavier border. It needs a different background, or more space.
 */
export const stroke = {
  /** The entire border scale. Cards, panels, inputs, chips, badges, dividers,
   *  section rules, hero block edges, accent edges, the stamp outline. */
  hair: 1,
} as const;

export type StrokeToken = keyof typeof stroke;

/** The four colours that do the work `stroke` deliberately does not. */
export const ruleTone = {
  /** List dividers, card and panel borders. Quietest, most used. */
  soft: colors.ruleSoft,
  /** Input borders, chip outlines, the time rail. A boundary you can act on. */
  strong: colors.ruleStrong,
  /** Structural edges: hero block, stat triplet. Rationed. */
  structural: colors.paper,
  /** The accent edge. Section openers, the stamp, accent left-borders. */
  accent: colors.red,
} as const;

/**
 * Lines that are NOT borders, so they are NOT on the scale above. Do not
 * reach for these to draw a box.
 */
export const lineWeight = {
  /** Accessibility affordance, and the only line in the UI heavier than a
   *  hairline, which is exactly what a focus indicator should be. */
  focusRing: 2,
  /** The icon family's drawn line, fixed at every rendered size. Icons are
   *  content, so they sit above the chrome scale on purpose: the frame should
   *  recede, the mark should not. */
  icon: 1.75,
  /** The hand-off ribbon's artwork line weight. Illustration, not chrome. */
  ribbon: 34,
} as const;

export const radius = {
  sm: 6,
  md: 8,
  lg: 10, // equals --radius: 0.625rem, which this redesign does not touch
  xl: 14,
  card: 16,
  pill: 999,
} as const;

/**
 * Court Reporter is a print system. Two shadows exist, both named, both
 * scoped to marketing surfaces. Everything else separates with a rule.
 */
export const elevation = {
  sheet: '0 50px 100px -30px rgba(0, 0, 0, 0.65)',
  cta: '0 14px 30px -12px rgba(184, 32, 45, 0.55)',
} as const;

/* ── motion ──────────────────────────────────────────────────────────── */

export const motion = {
  ease: {
    out: 'cubic-bezier(0.23, 1, 0.32, 1)',
    inOut: 'cubic-bezier(0.77, 0, 0.175, 1)',
    drawer: 'cubic-bezier(0.32, 0.72, 0, 1)',
  },
  /** GSAP names for the same three curves. Keep these in lockstep with ease. */
  gsapEase: {
    out: 'power3.out',
    inOut: 'power4.inOut',
    drawer: 'power2.out',
  },
  duration: {
    press: 140,
    hover: 160,
    tooltip: 160,
    dropdown: 200,
    drawer: 320,
    modal: 400,
    reveal: 600,
    hero: 700,
  },
  stagger: {
    row: 50,
    reveal: 120,
    line: 120,
  },
  pressScale: 0.97,
} as const;

export type EaseToken = keyof typeof motion.ease;
export type DurationToken = keyof typeof motion.duration;

/* ── the surface split ───────────────────────────────────────────────── */

/**
 * Hard product requirement from CLAUDE.md, not a style preference.
 * Same tokens, two intensities.
 */
export const surfaceSplit = {
  marketing: {
    routes: ['/', '/login', '/signup', '/forgot-password', '/reset-password/[token]', '/share/[token]'],
    allows: ['stamp', 'redaction', 'ribbon', 'display-type', 'shadow-cta', 'shadow-sheet', 'hero-timeline', 'scroll-reveal'],
    maxType: 180,
    maxDuration: 700,
  },
  product: {
    routes: ['/ (signed in)', '/meeting/[id]'],
    forbids: ['stamp', 'redaction', 'ribbon', 'display-type', 'shadow-cta', 'hero-timeline'],
    maxType: 30,
    maxDuration: 400,
    yellowAllowedFor: ['search-match-mark', 'status-transcribing'],
    redAllowedFor: ['primary-action-fill', 'focus-ring', 'status-failed'],
  },
} as const;

/* ── shadcn slot map ─────────────────────────────────────────────────── */

/**
 * The exact variable names app/globals.css already declares, mapped to
 * Court Reporter. Values are oklch to match that file's existing format.
 *
 * TRAP: shadcn's `accent` is the subtle hover surface, NOT the brand accent.
 * The brand's stamp red lands on `primary` and `ring`.
 */
export const shadcnSlots = {
  dark: {
    background: { oklch: 'oklch(0.164 0.002 286.17)', hex: colors.ink },
    foreground: { oklch: 'oklch(0.958 0.010 87.47)', hex: colors.paper },
    card: { oklch: 'oklch(0.193 0.006 285.82)', hex: colors.inkRaised },
    cardForeground: { oklch: 'oklch(0.958 0.010 87.47)', hex: colors.paper },
    popover: { oklch: 'oklch(0.193 0.006 285.82)', hex: colors.inkRaised },
    popoverForeground: { oklch: 'oklch(0.958 0.010 87.47)', hex: colors.paper },
    primary: { oklch: 'oklch(0.508 0.186 23.32)', hex: colors.redFill },
    primaryForeground: { oklch: 'oklch(0.958 0.010 87.47)', hex: colors.paper },
    secondary: { oklch: 'oklch(0.226 0.000 89.88)', hex: colors.rule },
    secondaryForeground: { oklch: 'oklch(0.958 0.010 87.47)', hex: colors.paper },
    muted: { oklch: 'oklch(0.219 0.006 285.91)', hex: colors.inkHover },
    mutedForeground: { oklch: 'oklch(0.632 0.006 106.57)', hex: colors.textMuted },
    accent: { oklch: 'oklch(0.219 0.006 285.91)', hex: colors.inkHover },
    accentForeground: { oklch: 'oklch(0.958 0.010 87.47)', hex: colors.paper },
    destructive: { oklch: 'oklch(0.642 0.197 20.58)', hex: colors.redText },
    border: { oklch: 'oklch(0.258 0.007 285.87)', hex: colors.ruleSoft },
    input: { oklch: 'oklch(0.287 0.007 285.93)', hex: colors.ruleStrong },
    ring: { oklch: 'oklch(0.612 0.208 22.24)', hex: colors.red },
    sidebar: { oklch: 'oklch(0.179 0.004 285.98)', hex: colors.inkApp },
  },
  /** Unchanged by this redesign. */
  radius: '0.625rem',
} as const;
