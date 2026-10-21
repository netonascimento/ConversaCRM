# Conversa CRM Design System

One design system covers the landing page, the app and the admin. The source of truth is `public/ds.css`. `public/app.css` builds on it and adds only app layout and patterns. `public/landing.html` inlines a copy of the tokens so it can render as a standalone file. The audience pages (`/mei`, `/advogados`, `/crm`) share `public/lp.css`, a copy of the landing styles plus their own blocks, and `public/lp.js`. If you change a token, change it in all three places (`ds.css`, `landing.html`, `lp.css`).

**Direction:** clean, editorial, calm. Deep brand green on warm off-white paper. A display serif for titles and big numbers, a precise grotesk for everything else. Borders do the work that heavy shadows usually do. One quiet accent (brass), used rarely.

## Tokens

| Group | Tokens | Notes |
|---|---|---|
| Brand | `--green-950…--green-50`, `--brass`, `--brass-soft` | `--green-800` (#14532d) is the primary color. `--green-600` (#1f7a45) is for links, focus, accent text and charts. Use brass only for "Recomendado", counters and dedicated/premium items. |
| Neutrals | `--paper` (page), `--paper-2` (sunken), `--surface` (cards, inputs, modals), `--ink`, `--ink-2`, `--muted`, `--faint`, `--line`, `--line-2`, `--line-strong`, `--overlay` | All are warm neutrals. Never use pure #fff or #000 for surfaces or text. |
| Semantic | `--success/-soft/-ink`, `--warning/…`, `--danger/…`, `--info/…`, `--violet/…`, `--neutral-soft` | The base color is for borders and icons, `-soft` for backgrounds, `-ink` for text on `-soft`. |
| Type | `--font-display` (Instrument Serif), `--font-sans` (Geist), `--font-mono` (Geist Mono). Scale: `--fs-11 … --fs-72` | The app body is 14px and the landing body is 16.5px. |
| Spacing | `--s-1` (4) · `--s-2` (8) · `--s-3` (12) · `--s-4` (16) · `--s-5` (20) · `--s-6` (24) · `--s-8` (32) · `--s-10` (40) · `--s-12` (48) · `--s-16` (64) · `--s-20` (80) · `--s-30` (120) | Everything uses a 4px grid. |
| Radii | `--r-xs` 4 · `--r-sm` 6 (controls) · `--r` 10 (cards) · `--r-lg` 16 (modals, marketing cards) · `--r-xl` 22 · `--r-pill` | Do not round everything to the max. |
| Elevation | `--shadow-0` (hairline) · `--shadow-1` (hover/raised) · `--shadow-2` (popover, toast) · `--shadow-3` (modal, drawer) | Cards at rest use a border plus `--shadow-0`. |
| Focus / motion | `--focus-ring`, `--focus-outline`, `--ease`, `--dur-1/2/3` | Motion respects `prefers-reduced-motion`. |
| Controls | `--control-h` 38 · `--control-h-sm` 30 · `--control-h-lg` 46 | Buttons and inputs share the same heights. |

Legacy aliases (`--green`, `--green-dark`, `--card`, `--border`, `--red`, …) are still defined because inline styles in `app.js` and `admin.js` use them. Do not use them in new code.

Dark theme is opt-in. Add `class="theme-auto"` (follows the OS) or `data-theme="dark"` to `<html>`. The landing page follows the OS. The app stays light for now because `app.js` has some hard-coded colors.

## Typography rules
- **Display serif** (`h1`, `.display`, KPI values, modal titles, prices): this is the brand voice. Never use it for body text or UI labels. Put emphasis in *italic* green (`<em>`).
- **Sans**: all UI text. Use weight 600 for headings inside cards (`h2`, 15–16px) and 500 for buttons and labels.
- **Mono, uppercase, tracked** (`.eyebrow`, `.kpi .label`): use for section kickers, metric labels and timestamps.
- Use tabular numbers (`.tnum`, tables, KPIs, prices) wherever numbers line up.

## Components (ds.css)
- **Buttons**: `button`/`.btn` is the *secondary* default. Add `.primary`, `.ghost`, `.danger`, `.link`, sizes `.sm`/`.lg`, plus `.pill` and `.block`.
  - **Primary**: at most **one per view or region**. It is the action that moves the journey forward (Salvar, Agendar, + Novo lead, Começar grátis).
  - **Secondary**: the alternatives (Cancelar, Hoje, Ficha, Reenviar).
  - **Ghost**: low-weight inline or icon actions (close ✕, row actions, Sair).
  - **Danger**: destructive actions. Use `.ghost.danger` in table rows, and `.primary.danger` only inside a confirmation step.
  - **Marketing** (landing) uses the same colors with `.pill` and the `lg` height. The app uses `--r-sm` corners.
- **Forms**: `.field` > `label` + control + `.hint`. `.fields` gives a 2-column grid that becomes 1 column under 760px. `.check` is for checkbox rows. Use `aria-invalid="true"` or `.invalid` for errors, plus `.error-text`.
- **Card**: `.card` (20px padding) with an optional `.card-head` (h2, spacer, small link or button).
- **Badge**: `.badge` plus `.green` `.amber` `.red` `.blue` `.purple` `.brass` `.outline` `.dot`. `.badge.count` is for sidebar counters.
- **Tabs**: `.tabs > button.active`. Use them for sub-views on the same page. For mutually exclusive filters in a small space, use `.segmented`.
- **Table**: plain `table` inside `.card` or `.table-wrap`. Use `tr.clickable` for rows that open a detail view.
- **Modal / drawer**: `.overlay > .modal(.wide)` or `.overlay.drawer-overlay > .drawer`. Each has a `.modal-head` (serif title + ghost ✕), a body, and a `.modal-foot` (secondary on the left, primary on the right). The head and foot stay pinned while the body scrolls.
- **Toast**: `.toast` (default/success) or `.toast.error`. Keep it short and non-blocking.
- **Banner**: `.banner` (warning, default), `.banner.info`, `.banner.success`, `.banner.danger`. It is page-level and goes under the page header.
- **Empty**: `.empty` with an optional serif `h3`, one sentence, and one primary button.
- **Code**: `.code` (inline) and `.pix` (copy-and-paste block, dashed border).

## Patterns
- **Page header** (`.page-head`): serif `h1` (34px) plus a one-line muted `p` on the left; `.spacer`; then actions on the right, in the order filters → secondary → **one primary**. A hairline sits under the header and 24px of space follows it.
- **Spacing rhythm**: 16px between cards in a grid, 20px inside cards, 24px between page sections, 32–40px page padding on desktop and 16px on mobile. Landing sections use 120px (88px on mobile).
- **Forms**: one column on mobile and two on desktop. The label goes above the field and the hint below it. The primary action goes at the bottom right in `.modal-foot`. In long settings forms, that footer becomes a sticky save bar.
- **Status colors** are used the same way everywhere:
  - green (success): pago, ativo, ganho, conectado, no prazo
  - amber (warning): pendente, solicitado / a confirmar, modo demonstração
  - red (danger): vencido, atrasado, perdido, faltou, cancelado
  - blue (info): confirmado, novo lead, concluído (in sequences)
  - violet: em contato
  - neutral: inactive or no status
- **Agenda**: appointments use a soft fill with a 3px left rule in the status color. "Solicitado" uses a dashed rule. Closed hours are hatched.
- **Navigation**: a deep green sidebar. The active item has a light rule on its left edge. Counters are brass.
- **Icons**: inline SVG line icons with 1.5–1.7 stroke. Emoji are never used as section icons.
