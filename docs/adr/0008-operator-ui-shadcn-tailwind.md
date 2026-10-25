# The operator and viewer UI is built with shadcn/ui on Tailwind CSS

The Vite/React SPA's interface is built with **shadcn/ui** — accessible
component source (Radix UI primitives underneath) copied into the repo under our
own control — styled with **Tailwind CSS**, with the "Studio Dark" palette
expressed as Tailwind theme tokens. This replaces the earlier hand-written
single stylesheet and plain-`className` components. We adopt it because the
agreed "Model 2" flow (ADR referenced in the spec / `prototype/look-and-feel`)
leans on drawers, modal dialogs, toasts, switches and keyboard-navigable selects
whose focus management, `Escape` handling and ARIA wiring are easy to hand-roll
*wrong*, and because the product is **mobile-first / portrait**, where Tailwind's
responsive utilities make the two-pane→single-pane degradation cheap.

**Amends ADR-0001; does not supersede it.** ADR-0001's ownership principle is
preserved and is in fact why we chose shadcn over the alternatives: shadcn
components are *vendored into the repo* (readable, editable, no runtime
framework magic — Radix is an unstyled primitive, not an abstraction that hides
behaviour), so a human can still read and own every line without an LLM. What
changes is the implicit "plain CSS, fewest possible deps" reading of ADR-0001:
Tailwind's utility-class model and a build-time dependency are now sanctioned for
the UI, as the deliberate price of accessibility correctness and responsive
ergonomics.

## Considered options

- **shadcn/ui + Tailwind (chosen).** Owned in-repo, Radix a11y, best mobile-first
  ergonomics. Cost: adopts Tailwind and migrates the existing `styles.css`.
- **Bare Radix primitives + keep hand-written CSS.** Smallest footprint and the
  strongest literal fit to ADR-0001, but leaves us hand-writing all component CSS
  and every responsive breakpoint — more a11y-adjacent CSS to get right by hand.
- **A full styled kit (MUI / Mantine).** Rejected: each brings its own theming
  system that would fight the Studio Dark direction and hide more behaviour.
- **SpartanUI.** Rejected: it is Angular-only; our stack is React (ADR-0004), and
  shadcn/ui is the React equivalent of the same "primitives + Tailwind +
  copy-paste" model.
