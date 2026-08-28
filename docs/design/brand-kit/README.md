<!-- @moodforge
schema: 1.0
round: 3
phase: brand-kit
worker: moodforge-brand-architect
theme: court-reporter
version: v1
created_at: 2026-08-28T00:00:00Z
sha256: d93a2bc6e33f66e095b6927562e83c281cea4bca6d9f4d2232f08b2c0a2dd996
artifact_role: spec
references: [docs/design/brand-kit/index.html, docs/design/brand-kit/tokens.css, docs/design/brand-kit/tokens.ts, docs/design/brand-kit/tokens.json, app/globals.css]
summary: Engineer-facing integration guide for Court Reporter v1. How to merge tokens into app/globals.css, the three easing curves verbatim, the ten motion rules verbatim, the WCAG status, and the open items.
-->

# Court Reporter · brand kit v1

The product's real output, a diarised Hinglish meeting transcript, is the hero graphic.
Near-black paper stock, warm paper white, one stamp red and one highlighter yellow.
Headlines in Big Shoulders Display, uppercase and heavy. Every number the machine produces
(timestamps, costs, durations, speaker tags, model names) in IBM Plex Mono. Body copy stays
on the Geist face the app already ships. It is editorial and confident on the front door,
and it goes quiet the moment you sign in.

Open **[`index.html`](./index.html)** for the visual brand book. Eleven sections, a full WCAG
matrix, and seven live motion demos with a slow-motion scrub and a reduced-motion simulator
built into the top bar.

---

## How to integrate

This app already has a working oklch dark theme wired through the shadcn `base-nova` preset
on Base UI. Court Reporter is applied by **replacing values in `app/globals.css`**, not by
adding a second theme layer.

1. Open `app/globals.css`.
2. Replace the whole `.dark { ... }` block with the `.dark` block from
   [`tokens.css`](./tokens.css) section 9. Variable names are identical, only the values move.
3. Optionally replace the `:root { ... }` block too. The app is always dark
   (`className="dark"` on `<html>`, no toggle), so `:root` is never active today, but
   `tokens.css` fills it in with the paper side of the brand so the light branch stops lying.
4. Leave `--radius: 0.625rem` alone. It is not part of this redesign.
5. Leave the `@theme inline` block alone. It maps variables to Tailwind utilities and needs
   no changes.
6. Add the brand primitives (the `--cr-*` block from `tokens.css` sections 1 through 10) to
   the same file, inside `:root`. These are the values that have no shadcn slot: the display
   font stack, the type ladder, the stroke weights, the rule tones, the motion tokens, the status tints.
7. Load the two webfonts. Both are free Google Fonts:

   ```
   https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@800;900&family=IBM+Plex+Mono:ital,wght@0,400;0,500;0,600;1,400&display=swap
   ```

   Prefer `next/font/google` over a `<link>`, so they are self-hosted and there is no
   layout shift.

### About `tokens.ts`

This app is JavaScript, and its `CLAUDE.md` forbids introducing `.ts`/`.tsx` files into app
source. [`tokens.ts`](./tokens.ts) is a **design-system artifact, not app source**. It exists
so Style Dictionary, Figma token plugins, and a human reading one file have a typed source of
truth. Do not add an import of it to `app/` or `backend/`. The app's integration path is
`tokens.css`.

[`tokens.json`](./tokens.json) is the same data in DTCG format for tooling.

### Three traps specific to this project

1. **This is Base UI, not Radix.** Use `render={<a href="..." />}`, never `asChild`. Pass
   `nativeButton={false}` when a `Button` renders as an anchor. `DropdownMenuLabel` must sit
   inside a `DropdownMenuGroup`.
2. **shadcn's `--accent` is not the brand accent.** In shadcn it is the subtle hover surface
   behind menu items and rows. Setting it to stamp red turns every dropdown hover into a red
   block. The brand red lands on `--primary` and `--ring`.
3. **Never use `text-primary` on dark.** `--primary` is `#B8202D`, a surface colour, and
   measures 3.02:1 as text on the canvas. Red text uses `--cr-red-text` (`#EC4B57`), which is
   also what `--destructive` is set to.

---

## The surface split (hard requirement, not a preference)

From the project's own `CLAUDE.md`. Same tokens, two intensities.

**Marketing surfaces** get the full expression: `/` when signed out, `/login`, `/signup`,
`/forgot-password`, `/reset-password/[token]`, `/share/[token]`.
Allowed: the DIARISED stamp, redaction bars, the hand-off ribbon at full size, type up to
180px, the sheet shadow, the CTA glow, the GSAP hero timeline, `ScrollTrigger.batch` reveals,
durations up to 700ms.

**Product surfaces** stay restrained and fast: `/` when signed in, `/meeting/[id]`, and every
dialog reachable from them.
Forbidden: stamps, redaction, the ribbon (except the empty state at 40% scale), type above
30px, the CTA glow, the hero timeline, any duration above 400ms.
Yellow is the search-match `<mark>` and the Transcribing status, nothing else.
Red is the primary action fill, the focus ring, and the Failed status, nothing else.

---

## Borders

**The border scale is one value: `--cr-stroke-hair: 1px`.** Emphasis is carried by the rule's
*colour*, never by its weight. A quiet divider and a structural edge are the same hairline in
two different colours, which is how a printed page does it.

| Rule tone | Colour | Use |
|---|---|---|
| soft | `--cr-rule-soft` `#232327` | List dividers, card and panel borders. The quietest, and the most used. |
| strong | `--cr-rule-strong` `#2A2A2E` | Input borders, chip outlines, the time rail. A boundary you can act on. |
| structural | `--cr-paper` `#F4F1EA` | The hero block's top and bottom edge, the stat triplet. Rationed. |
| accent | `--cr-red` `#E63946` | Section openers, the stamp outline, accent left-borders. The heaviest thing this system says, said at 1px. |

**History, so this does not get undone.** v1 of this kit shipped `--cr-stroke-emph` at 2px and
`--cr-stroke-stamp` at 2.5px, and the system read as a stack of thick bordered boxes. Both were
removed. A 1.5px middle tier was then tried as a replacement and *also* removed, for a concrete
reason: **Blink floors sub-pixel border widths**, so `border: 1.5px` computes and paints as
`1px` in Chrome at any `devicePixelRatio`, while Safari and Firefox honour it. A tier that only
exists in two of three engines is not a tier, it is an inconsistency. Verified directly:
a probe element with `border-top: 1.5px` reports `borderTopWidth: "1px"` at both DPR 1 and DPR 2,
while `2px` reports `2px`.

Do not add the heavier tokens back. If a box seems to need more weight than a hairline, it does
not need a heavier border: it needs a different background, or more space.

Three line weights exist that are **not borders** and are not on the scale above. Do not reach
for them to draw a box.

| Token | Value | Why it is exempt |
|---|---|---|
| `--cr-focus-ring` | `2px` | Accessibility affordance, and now the only line in the UI heavier than a hairline, which is exactly what a focus indicator should be. Never trade this down for aesthetics. |
| `--cr-stroke-icon` | `1.75px` | The icon family's drawn line, fixed at every rendered size. Icons are content, so they sit above the chrome scale on purpose: the frame should recede, the mark should not. |
| `--cr-stroke-ribbon` | `34px` | The hand-off ribbon's artwork line weight. Illustration, not chrome. Locked. |

---

## Motion

### The three easing tokens, verbatim

```css
--cr-ease-out:    cubic-bezier(0.23, 1, 0.32, 1);   /* GSAP power3.out   */
--cr-ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);  /* GSAP power4.inOut */
--cr-ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);   /* GSAP power2.out   */
```

**Never change these three values.** They are the entire motion vocabulary of the product.
Adding a fourth curve, or nudging one of these, is a design decision and needs review, not a
one-line commit.

### The duration scale

| Token | ms | Applies to | Surface |
|---|---|---|---|
| `--cr-dur-press` | 140 | `scale(0.97)` on `:active`, toggle knob | both |
| `--cr-dur-hover` | 160 | background, colour, border change | both |
| `--cr-dur-tooltip` | 160 | tooltips, small popovers | both |
| `--cr-dur-dropdown` | 200 | dropdown menu, select, avatar menu | both |
| `--cr-dur-drawer` | 320 | drawers and sheets | both |
| `--cr-dur-modal` | 400 | dialogs. **The product ceiling.** | both |
| `--cr-dur-reveal` | 600 | `ScrollTrigger.batch` entrance | marketing |
| `--cr-dur-hero` | 700 | landing hero timeline step | marketing |
| `--cr-stagger-row` | 50 | app list rows | both |
| `--cr-stagger-reveal` | 120 | landing panels | marketing |
| `--cr-stagger-line` | 120 | transcript lines typing on | marketing |
| `--cr-press-scale` | 0.97 | every pressable element, no exceptions | both |

### The ten hard rules, verbatim

1. **Never animate a keyboard-initiated action.** Escape, Enter, Cmd+K, arrow keys. Those fire
   hundreds of times a day and animation makes them feel broken.
2. **Never use `ease-in` on UI.** It delays the first movement, which is the exact frame the
   user is watching hardest, so a 200ms `ease-in` feels slower than a 200ms `ease-out`.
3. **Never animate from `scale(0)`.** Start at 0.95 or higher, combined with opacity. Nothing
   in the real world appears from nothing.
4. **Never use `transition: all`.** Name the properties. `all` animates things you did not
   intend and pays for layout you did not need.
5. **Only animate `transform` and `opacity`.** Width, height, margin and padding trigger
   layout on every frame.
6. **Popovers scale from their trigger** (`transform-origin: var(--transform-origin)`).
   Modals are the one exception and stay centred, because they are not anchored to a trigger.
7. **Exits are faster than entrances.** The user has already decided; do not make them wait
   for the system to agree.
8. **Transitions, not keyframes,** for anything that can be re-triggered mid-flight.
   Keyframes restart from zero; transitions retarget from their current value.
9. **Gate hover animations** behind `@media (hover: hover) and (pointer: fine)`. Touch devices
   fire hover on tap.
10. **Reduced motion means fewer and gentler, not none.** Keep opacity and colour transitions,
    which aid comprehension. Remove travel, scale, and the ribbon draw.

All motion in this product is reviewed by `emil-design-eng`. Change an easing or a duration
without consulting it and you are breaking the system.

### CSS or GSAP

CSS transitions are the default: press, hover, focus, open, close. They run off the main
thread, so they stay smooth while Next.js is hydrating or the dashboard is polling every four
seconds, and they are interruptible.

Reach for GSAP when there is a timeline (the landing hero), a stagger across a collection
(transcript lines, dashboard rows), or anything scroll-driven (`ScrollTrigger.batch`).
Do not reach for it to fade one element.

One GSAP note worth knowing before you copy the ribbon: SVG groups that already carry a
`transform` attribute must be wrapped in a plain untransformed `<g>` before you tween `x`
on them, otherwise GSAP parses the existing translate as its own baseline and the element
snaps to the wrong position. `assets/handoff-ribbon.svg` already has the wrappers.

---

## WCAG status

Every real text-on-background pairing was measured with the WCAG 2.1 relative luminance
formula. The full matrix (24 passing pairs, 7 rejected pairs) is in section 02 of
[`index.html`](./index.html) and in `contrast` / `contrastRejected` in
[`tokens.ts`](./tokens.ts).

**Nothing ships below 4.5:1 for body text.** Seven pairings failed and all seven were fixed
rather than waived. Five of them were live in the approved Round 2 screens, so these are real
corrections to a real design.

| Failed pairing | Ratio | Fix that shipped |
|---|---|---|
| `--cr-paper` on `#E63946` (Round 2 hero CTA label) | 3.70:1 | Button surface is now `--cr-red-fill` `#B8202D`. Paper on it is **5.67:1**. |
| `#E63946` on `--cr-paper` (the DIARISED stamp text) | 3.70:1 | Red text on paper is now `--cr-red-fill` `#B8202D`, **5.67:1**. The 1px stamp *border* may stay `#E63946`: it is a graphic and needs 3:1, which 3.70:1 clears. |
| `#E63946` on `#141417` (the EXHIBIT A/B/C labels) | 4.41:1 | Red text on any raised surface is now `--cr-red-text` `#EC4B57`, **5.00:1**. |
| `#E63946` on the Failed status tint | 4.13:1 | Same fix, `--cr-red-text`, **4.68:1**. |
| `#6B675F` on `--cr-ink` (the 11px meta line, and the landing footer) | 3.43:1 | Text floor is now `--cr-text-muted` `#8A8A86`, **5.57:1**. `#6B675F` is demoted to `--cr-hairline`, decoration only, never a text colour. |
| `#B8202D` on `--cr-ink` (would be `text-primary`) | 3.02:1 | Never use shadcn `--primary` as a text colour on dark. Use `--cr-red-text`. |
| `#FFD23F` on `--cr-paper` | 1.28:1 | Never. Yellow on paper is a background with ink on top, not a text colour. |

### Use sparingly

- **`--cr-red` `#E63946` as body text** measures 4.63:1 on `--cr-ink` and passes, but only
  just, and only on the base canvas. On any lifted surface it drops below 4.5:1. Prefer
  `--cr-red-text` whenever you are not certain what is behind it.
- **`--cr-text-muted` `#8A8A86`** at 5.57:1 is the floor, not a comfortable default. It is
  correct for the 11px meta line and placeholders. It is wrong for a paragraph.
- **Non-text contrast:** the focus ring (`--cr-red` at 4.63:1) clears SC 1.4.11. Input borders
  (`--cr-rule-strong`, 1.44:1) do not, which is why every field in this system pairs its
  border with a visible label and a focus ring rather than relying on the border alone.

---

## File index

| File | What it is |
|---|---|
| [`index.html`](./index.html) | The visual brand book. Eleven sections, live motion demos. Start here. |
| [`tokens.css`](./tokens.css) | Production CSS custom properties, plus the oklch `.dark` / `:root` blocks that drop straight into `app/globals.css`. **The integration path.** |
| [`tokens.ts`](./tokens.ts) | Typed token export for tooling and Figma. Not app source. |
| [`tokens.json`](./tokens.json) | DTCG format for Style Dictionary and Figma token plugins. |
| [`assets/wordmark.svg`](./assets/wordmark.svg) | Primary wordmark. **Placeholder name**, live text, one-string swap. |
| [`assets/wordmark-mono.svg`](./assets/wordmark-mono.svg) | Single-colour wordmark, `currentColor`. Favicons, embroidery, single-colour print. |
| [`assets/wordmark-inverse.svg`](./assets/wordmark-inverse.svg) | Wordmark on paper. Uses `--cr-red-fill` for the period, per the WCAG fix above. |
| [`assets/mark-icon.svg`](./assets/mark-icon.svg) | The icon-only mark. **Not a placeholder**: no letterforms, so it survives the naming decision. |
| [`assets/handoff-ribbon.svg`](./assets/handoff-ribbon.svg) | The locked hand-off illustration, with the animation contract and the GSAP wrapper groups. |
| [`assets/icons.svg`](./assets/icons.svg) | The 24-icon family as an SVG sprite. 24 grid, 1.75 stroke, butt caps, miter joins. |
| [`assets/motifs.svg`](./assets/motifs.svg) | Stamp, redaction bar, speaker tag, waveform strip. Three of the four are marketing-only. |

### Missing shadcn components

Five components the design uses are not installed yet:

```bash
npx shadcn@latest add switch checkbox tooltip table empty
```

Do **not** re-run `npx shadcn@latest apply <preset>`. That would overwrite the Court Reporter
values in `app/globals.css` with the stock `nova` neutral theme.

---

## Open items

1. **The product name.** The wordmark is a placeholder (`MEETING.TXT`, carried over from the
   Round 2 mockup). Every wordmark file uses live `<text>` rather than outlined paths
   specifically so swapping the name is editing one string per file, with no vector work.
   The icon mark carries no letterforms and does not need to change. Outline the wordmark only
   once the name is final and only for print.
2. **The `destructive` variant needs restyling.** In this brand the primary action is already
   red, so a filled red delete button is visually identical to Upload. The brand kit specifies
   destructive as an **outline**, and `components/ui/button.jsx` currently ships a fill. That
   is a real code change, not a token change.
3. **Body face.** The brand kit is written against Geist, per the project's shadcn preset.
   The Round 2 mockup used Inter as a stand-in, and `index.html` still does, since the brand
   book is a standalone HTML file with no access to `next/font`. They are close enough that
   nothing in the specimens changes, but the shipped app should use Geist.
