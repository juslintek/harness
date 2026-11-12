# Harness — Style Reference
> A quiet, dense engineering tool. Neutral surfaces, one blue accent, colour only for status.

**Theme:** light (default). A dark theme is the secondary system `dark`, see `design-systems/dark/DESIGN.md`. **Source:** picked from the product brief on 2026-11-11.

Values in this file are for reading. `theme.css` is the source of truth.

## Summary

Harness is a self-hosted workspace where people supervise coding agents. Its users are engineers who read tables, logs and diffs all day. The system uses a pale grey canvas, white panels, 1px borders and one blue accent. Colour is spent on status and on the primary action, nowhere else. It refuses web fonts, gradients, decorative shadows, large radii and colour as the only signal of status.

## Colors

| Name | Token | Value | Role |
|---|---|---|---|
| Canvas | `--color-canvas` | `#f6f7f8` | The page background behind panels |
| Panel | `--color-panel` | `#ffffff` | Panels, dialogs, menus, form controls |
| Text | `--color-text` | `#16191d` | Body text, headings, icons |
| Soft text | `--color-text-soft` | `#5b6470` | Labels, helper text, table headers, inactive tabs |
| Line | `--color-line` | `#dfe3e8` | Hairlines, panel borders, row dividers. Decorative only |
| Strong line | `--color-line-strong` | `#848d98` | Borders of form controls and checkboxes. Reaches 3:1 on the canvas and on panels |
| Action | `--color-action` | `#2f5fd0` | Primary button fill, links, active tab underline, focus. Never a status colour |
| Action tint | `--color-action-tint` | `#e6edfb` | Selected rows and the active nav item |
| On action | `--color-on-action` | `#ffffff` | Text on the action fill and on the danger fill |
| Alert | `--color-alert` | `#c0362c` | Destructive actions and error text |

## Roles

| Role | Token | Points at | Value |
|---|---|---|---|
| Page background | `--color-surface` | `--color-canvas` | `#f6f7f8` |
| Raised surface | `--color-surface-raised` | `--color-panel` | `#ffffff` |
| Text | `--color-ink` | `--color-text` | `#16191d` |
| Muted text | `--color-ink-muted` | `--color-text-soft` | `#5b6470` |
| Border | `--color-border` | `--color-line` | `#dfe3e8` |
| Control border | `--color-border-strong` | `--color-line-strong` | `#848d98` |
| Primary action | `--color-brand` | `--color-action` | `#2f5fd0` |
| Text on primary | `--color-on-brand` | `--color-on-action` | `#ffffff` |
| Accent surface | `--color-accent` | `--color-action-tint` | `#e6edfb` |
| Link | `--color-link` | `--color-action` | `#2f5fd0` |
| Danger | `--color-danger` | `--color-alert` | `#c0362c` |
| Overlay scrim | `--color-scrim` | — | `rgba(22, 25, 29, 0.4)` |
| Display face | `--font-display` | — | `system-ui, -apple-system, "Segoe UI", sans-serif` |
| Body face | `--font-body` | — | same |
| Code face | `--font-mono` | — | `ui-monospace, SFMono-Regular, Menlo, monospace` |

## Status

Five status roles. Each has a foreground and a soft background. A status is always shown with its word, never by colour alone. Foreground on its own background and on both surfaces reaches 4.5:1.

| Status | Foreground | Value | Background | Value |
|---|---|---|---|---|
| neutral | `--status-neutral` | `#5b6470` | `--status-neutral-bg` | `#eceef1` |
| info | `--status-info` | `#2f5fd0` | `--status-info-bg` | `#e6edfb` |
| success | `--status-success` | `#187543` | `--status-success-bg` | `#e2f4ea` |
| warning | `--status-warning` | `#8a5a00` | `--status-warning-bg` | `#fbf0d3` |
| danger | `--status-danger` | `#c0362c` | `--status-danger-bg` | `#fbe6e3` |

### Status mapping

Server enum value to status role. Every badge shows the value as its word.

| Status | Values |
|---|---|
| info | run `starting`, `running`; task `in_progress`; hire `interviewing`, `followups`, `answering`, `scoring`; candidate `interviewing`; wake `started` |
| success | run `completed`; task `done`; approval `approved`; guard `allow`; hire and candidate `hired`; budget `ok`; proposal `approved`; lesson `accepted`; wake `done` |
| warning | task `in_review`; hire `deciding`; guard `ask`; budget `warn`; approval `pending`; proposal `open`; lesson `pending` |
| danger | run `failed`, `killed`, `blocked`; task `blocked`; approval `denied`; guard `deny`; budget `paused`; hire and candidate `rejected`; candidate `failed`; wake `failed`; proposal and lesson `rejected` |
| neutral | run `queued`, `cancelled`; task `backlog`, `todo`, `cancelled`; approval `expired`; candidate `pending`, `answered`; hire `cancelled`; wake `pending`, `skipped`; proposal `withdrawn` |

## Typography

One system sans stack for everything, one monospace stack for code, ids and logs. No web fonts and no `@font-face`. Weights are 400 for text, 500 for labels and badges, 600 for headings, titles and the active nav item.

### Type scale

| Step | Size token | Size | Leading token | Leading | Use |
|---|---|---|---|---|---|
| caption | `--text-caption` | `12px` | `--leading-caption` | `1.45` | Labels, badges, table headers |
| body-sm | `--text-body-sm` | `13px` | `--leading-body-sm` | `1.45` | Tables, dense lists, nav, buttons |
| body | `--text-body` | `14px` | `--leading-body` | `1.45` | Base text |
| subheading | `--text-subheading` | `16px` | `--leading-subheading` | `1.45` | Panel and dialog titles |
| heading | `--text-heading` | `20px` | `--leading-heading` | `1.25` | Page titles |
| display | `--text-display` | `28px` | `--leading-display` | `1.25` | Dashboard figures. Rare |

## Spacing & shapes

Base unit 4px. Dense by default: rows are 36px, controls 32px, small controls 28px.

| Step | Token | Value |
|---|---|---|
| xs | `--space-xs` | `4px` |
| sm | `--space-sm` | `8px` |
| md | `--space-md` | `12px` |
| lg | `--space-lg` | `16px` |
| xl | `--space-xl` | `24px` |
| 2xl | `--space-2xl` | `32px` |

### Radius

| Element | Token | Value |
|---|---|---|
| Badges excluded, small controls, tabs, code blocks | `--radius-sm` | `4px` |
| Buttons, fields, panels | `--radius-md` | `6px` |
| Dialogs, large panels | `--radius-lg` | `8px` |
| Badges, count pills, switches | `--radius-pill` | `999px` |

### Shadows

| Use | Token | Value |
|---|---|---|
| Panels | `--shadow-card` | `none` |
| Dialogs and menus only | `--shadow-overlay` | `0 8px 24px rgba(22, 25, 29, 0.14)` |

Depth comes from 1px borders. The overlay shadow is the only shadow in the system.

### Layout

Panels pad `--space-lg` and sit `--space-lg` apart. Table rows are 36px high with a 1px `--color-border` divider. Sidebar rows are 32px high. A page never scrolls sideways at 375px wide: tables scroll inside their own panel.

## Components

Files are in `design-systems/default/components/`. All use roles only, so they follow `data-design-system="dark"`.

### Button
`button.html`. tone: primary (brand fill), secondary (raised fill, strong border), danger (danger fill), ghost (no fill, no border). size: sm 28px, md 32px. Radius `--radius-md`, text `--text-body-sm` at 500.

### Status badge
`status-badge.html`. tone: neutral, info, success, warning, danger. Pill, `--text-caption` at 500, status foreground on status background. Always carries the enum word.

### Field
`field.html`. kind: text, select, textarea; state: default or error. Label 12px muted above a 32px control with a `--color-border-strong` border. Error shows a danger line below the control and a danger border.

### Checkbox and switch
`checkbox.html`, `switch.html`. on or off. On uses the brand fill. Off uses a strong border.

### Panel
`panel.html`. Raised surface, 1px border, `--radius-md`. Header row with a 14px title at 600 and an actions slot, then a body slot.

### Tabs
`tabs.html`. Three tabs. The active one has ink text and a 2px brand underline. Others are muted.

### Data table
`data-table.html`. 12px muted header, three 13px rows at 36px, 1px dividers, one status badge column.

### Meter
`meter.html`. 6px bar. tone success, warning or danger, with a value label. The label carries the meaning, not the colour.

### Dialog
`dialog.html`. 480px, raised, `--radius-lg`, `--shadow-overlay`. Title, body, footer with secondary and primary buttons.

### State
`state.html`. kind loading, empty or error. Centred muted text. Error adds a danger line and a Retry button.

### Nav item
`nav-item.html`. state default, active or with-count. 32px row, 13px label. Active has `--color-accent` background and 600 ink text. The count is a neutral pill.

### Code block
`code-block.html`. 12px monospace on a `--status-neutral-bg` surface with a 1px border and a ghost Copy button at top right.

### Org switcher
`org-switcher.html`. state closed or open. A 36px row with the current org name at 600, the person's role in it (viewer, member, admin or owner) in muted caption, and a chevron. Open adds a menu with `--shadow-overlay` listing the orgs; the current one has the accent background and the word "Current".

### Halt switch
`halt-switch.html`. state running or halted. A 32px top bar control: a label and a switch, where on means halted. Halted uses the danger background, border and text with the word "Halted". Only instance admins see it.

### Sidebar
`sidebar.html`. One variant, 240px wide. Org switcher on top, then the groups Work, Oversight, Organisation and Instance as nav items, Board active. The Approvals count pill uses the warning status. The Account row and the signed-in email sit at the bottom.

### Step-up
`step-up.html`. One variant, a 480px dialog that asks for a fresh passkey check (valid 5 minutes). Title, body, a monospace line naming the action being confirmed, then Cancel and a primary "Use passkey" button.

## Do's and Don'ts

### Do
- Style with role tokens, never literal values.
- Show the status word in every badge.
- Use `--color-border-strong` for any border that identifies a control.
- Use `--font-mono` for ids, paths, commands and event logs.
- Keep tables at `--text-body-sm`, 36px rows.

### Don't
- Do not load web fonts or write `@font-face`.
- Do not use gradients.
- Do not add shadows except `--shadow-overlay` on dialogs and menus.
- Do not signal status by colour alone.
- Do not use radii above 8px, except pills.
- Do not let a page scroll horizontally at 375px.
- Do not use `--color-brand` for status. Use the status roles.

## Agent prompt guide

| Use | Token | Value |
|---|---|---|
| Page background | `--color-surface` | `#f6f7f8` |
| Panel | `--color-surface-raised` | `#ffffff` |
| Text | `--color-ink` | `#16191d` |
| Primary action | `--color-brand` | `#2f5fd0` |

- A panel: `--color-surface-raised` fill, 1px `--color-border`, `--radius-md`, padding `--space-lg`.
- A run row: 36px high, `--text-body-sm`, a status badge with the enum word, id in `--font-mono`.
- A form: labels `--text-caption` in `--color-ink-muted`, controls 32px with `--color-border-strong`.
- A destructive confirm: dialog with `--shadow-overlay`, danger button on the right.
