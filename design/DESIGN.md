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

Server enum value to status role. Every badge shows a word: the plain word from the next table, never a raw key.

| Status | Values |
|---|---|
| info | run `starting`, `running`; task `in_progress`; hire `interviewing`, `followups`, `answering`, `scoring`; candidate `interviewing`; wake `started` |
| success | run `completed`; task `done`; approval `approved`; guard `allow`; hire and candidate `hired`; budget `ok`; proposal `approved`; lesson `accepted`; wake `done` |
| warning | task `in_review`; hire `deciding`; guard `ask`; budget `warn`; approval `pending`; proposal `open`; lesson `pending` |
| danger | run `failed`, `killed`, `blocked`; task `blocked`; approval `denied`; guard `deny`; budget `paused`; hire and candidate `rejected`; candidate `failed`; wake `failed`; proposal and lesson `rejected` |
| neutral | run `queued`, `cancelled`; task `backlog`, `todo`, `cancelled`; approval `expired`; candidate `pending`, `answered`; hire `cancelled`; wake `pending`, `skipped`; proposal `withdrawn` |

### Status words

The badge word is plain English. The raw value goes in a tooltip or in mono small text, never as the label.

| Raw value | Word on the badge |
|---|---|
| `in_progress` | in progress |
| `in_review` | in review |
| `tool_call` | command |
| guard `ask` | guard asked |
| guard `deny` | guard denied |
| guard `allow` | guard allowed |
| `waiting_approval`, or a running run with a pending approval | waiting for you |
| other values with an underscore | the same words with spaces |
| budget `ok` | ok (success) |
| budget `warn` | near limit (warning) |
| budget `paused` | paused (danger) |
| approval `pending` | waiting for you (warning) |
| approval `approved` | approved (success) |
| approval `denied` | denied (danger) |
| approval `expired` | expired (neutral) |
| hire `deciding` | needs your decision (warning) |
| wakeup `pending` | queued (neutral) |
| wakeup `started` | running (info) |

"Waiting for you" (warning tone) is the loudest state wherever it appears. It is reserved for a run, approval or lesson with a pending decision. The Now top line counts the "Needs you" rows and reads "N need you". Ids look the same on every page: runs `r_4f2a9c`, approvals `ap_8d31e0`, tasks `#142`.

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

Layout sizes are tokens in `theme.css`. The app and these files both read them, so change a value there and nowhere else.

| Size | Token | Value |
|---|---|---|
| Sidebar width | `--size-sidebar` | `240px` |
| Top bar height | `--size-topbar` | `48px` |
| Control height (buttons, fields, nav rows) | `--size-control` | `32px` |
| Small control height | `--size-control-sm` | `28px` |
| Table and list row height | `--size-row` | `36px` |
| Dialog width | `--size-dialog` | `480px` |

## Components

Files are in `design-systems/default/components/`, all flat, because Recto reads them from that one folder. The levels below are recorded here only. All use roles, so they follow `data-design-system="dark"`. A molecule or organism file holds real nested instances of the atoms it uses (as `sidebar.html` holds `nav-item` and `org-switcher`), never a redrawn copy. Props: variants are written `axis=value`; `text` names are text layers an instance may reword; `slot` names take content; `show` names are layers an instance may hide.

### Atoms
One element. No component inside another.

| Name | File | Variants and props | For |
|---|---|---|---|
| Button | `button.html` | tone: primary, secondary, danger, danger-quiet, ghost, disabled; size: sm (28px), md (32px). text `label` | Every action. Filled `danger` only confirms, inside a confirm dialog. Routine remove, revoke, clear and stop use `danger-quiet`. At most one primary per view region. `disabled` has muted text, `aria-disabled="true"`; say why in a caption beside it. |
| Status badge | `status-badge.html` | tone: neutral, info, success, warning, danger. text `label` | A status as a plain word (table under Status words). Never without its word. |
| Tab | `tab.html` | state: default, active; count: none, neutral, warning. text `label`, `count` | One tab of a tab row. Active has ink text and a 2px brand underline. Neutral count is a muted mono number, warning count is a pill for work that waits for a person. |
| Checkbox | `checkbox.html` | state: on, off. text `label` | A yes or no choice. On uses the brand fill. |
| Switch | `switch.html` | state: on, off. text `label` | A setting applied at once. |
| Help | `help.html` | text `body` | One muted line under a heading or field for a hard concept (policy, autonomy level, budget, bridge, tunnel, step-up, recovery codes). |
| Meter | `meter.html` | tone: success, warning, danger. text `label`, `value` | A 6px bar. The label carries the meaning, not the colour. |

### Molecules
A few atoms used as one unit.

| Name | File | Variants and props | For |
|---|---|---|---|
| Field | `field.html` | kind: text, select, textarea; state: default, error. text `label`, `message` | Label above a 32px control. Error shows a danger line and border. |
| Notice | `notice.html` | tone: info, success, warning, danger. text `title`, `body`; slot `actions` | Banners, the result of an action, inline help and the halted banner. No icon. |
| Steps | `steps.html` | state: done, current, todo. text `label`, `number` | One step of a flow strip (hiring, tunnel, enrol). State shows in the mark and the weight, not only colour. |
| Tabs | `tabs.html` | slot `items` (holds `tab` instances) | A tab row. Approvals, Memory and Settings at 375 fill it. |
| Nav item | `nav-item.html` | state: default, active; count: none, neutral, warning. text `label`, `count` | A 32px sidebar row with an optional count pill (warning for pending approvals). |
| State | `state.html` | kind: loading, empty, error. text `title`, `message` | Centred muted text. Error adds a danger line and a Retry button. |
| Panel | `panel.html` | text `title`; slots `actions`, `body` | A raised titled box. |
| Dialog | `dialog.html` | text `title`, `body`; slot `actions` | A 480px modal. A confirm dialog puts the filled `danger` button on the right and names the object and the consequence. |
| Step-up | `step-up.html` | text `title`, `body`, `action` | The passkey check (valid 5 minutes) before a sensitive action. |
| Conn state | `conn-state.html` | state: live, reconnecting, offline. text `label` | A dot and a word in the top bar. At 375 shown only when not live. |
| Agents state | `agents-state.html` | state: running, stopped; role: admin, member; size: full, compact | Dot and word; admins also get "Stop all agents" (`danger-quiet`) or "Resume agents" (primary). Stopping asks in a dialog first, both ask for the passkey. |
| Org switcher | `org-switcher.html` | state: closed, open. text `org`, `role` | The current org and the person's real role in it (viewer, member, admin or owner). |
| Data table | `data-table.html` | none | Header row, rows at 36px, one status badge column. |
| Code block | `code-block.html` | none | A command or output in mono with a ghost Copy button. It holds a button, so it is a molecule. |
| Empty panel | `empty-panel.html` | slots `state` (a `state` instance), `actions` (buttons) | An empty list in a raised box: what it is, why it is empty, the first action as a button. |

### Organisms
A section of a screen.

| Name | File | Variants and props | For |
|---|---|---|---|
| Sidebar | `sidebar.html` | role: admin, org-admin, member. text `email`; slot `footer` | 240px. Groups: Now; Work (Board, Chat, Memory); Monitor (Approvals, Runs, Logs); Reports (Usage & budgets); Organisation (Hiring, Policies, Settings); Guides (Playbooks); Instance (Agent CLIs, Integrations, Search). Org admin (not instance admin) sees Approvals with its count and no Runs and no Instance group. Member sees neither Approvals, Runs nor Instance. Counts are a parameter of the generator; a missing or zero count draws no pill. |
| Top bar | `top-bar.html` | layout: desktop, mobile. slots `title`, `status` | The page title or breadcrumb on the left; `conn-state` then `agents-state` on the right. Mobile has the menu button and shows the connection only when not live. |
| Approval card | `approval-card.html` | layout: wide, narrow; frame: card, flat; urgent: no, yes. text `title`, `expires`, `at`, `agent`, `run`, `task`, `id`, `reason`; show `show-open`; slots `command` (a `code-block`), `extra` | One command waiting for a decision: who asked, which run and task, the command, Deny and Approve command. `extra` holds the refused notice (403 `instance_admin_required`) or a rule line. Used by Now, Approvals and the Run page. |
| Run row | `run-row.html` | layout: wide, narrow; waiting: no, yes. text `what`, `id`, `agent`, `model`, `why`, `cost`, `duration`, `started`, `extra`, `reason`, `corner`, `meta`; show `show-extra`, `show-model`, `show-reason`; slot `status` | One run: a table row (wide) or a card (narrow). A waiting run has a warning edge and a Review command action. Used by Runs and Now. |

## Product principles

- Every screen answers: what is happening, what needs me, what I can do next, what the result was and where it is.
- "Waiting for you" is the loudest state.
- Filled red only confirms: the `danger` button lives in confirm dialogs. Routine destructive actions are `danger-quiet`.
- No invented data: a screen shows only what the server returns.
- Guidance is labelled as guidance, not as live data.

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
