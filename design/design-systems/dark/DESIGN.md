# Harness Dark — Style Reference
> The dark variant of Harness. Same roles, same type, same spacing.

**Theme:** dark · **Source:** picked from the product brief on 2026-11-11.

Values in this file are for reading. `theme.css` is the source of truth. Set `data-design-system="dark"` on a frame's root to use it.

## Summary

The dark system keeps every role name of the default system and changes only colour values. Type, spacing and radii are unchanged. Surfaces step from `#0f1114` (canvas) to `#171a1f` (panel). The accent is a lighter blue. Status colours are lighter so they keep 4.5:1 on dark surfaces. The overlay shadow is stronger because it must show against a dark canvas.

## Colors

| Name | Token | Value | Role |
|---|---|---|---|
| Canvas | `--color-canvas` | `#0f1114` | Page background |
| Panel | `--color-panel` | `#171a1f` | Panels, dialogs, controls |
| Text | `--color-text` | `#e6e8eb` | Body text and headings |
| Soft text | `--color-text-soft` | `#9aa3ae` | Labels and helper text |
| Line | `--color-line` | `#2a2f37` | Hairlines and dividers. Decorative only |
| Strong line | `--color-line-strong` | `#68717d` | Control borders. Reaches 3:1 on canvas and panel |
| Action | `--color-action` | `#7aa2ff` | Primary fill, links, active underline |
| Action tint | `--color-action-tint` | `#1a2540` | Selected rows, active nav item |
| On action | `--color-on-action` | `#0f1114` | Text on the action and danger fills |
| Alert | `--color-alert` | `#ff7b72` | Destructive actions and error text |

## Roles

| Role | Token | Points at | Value |
|---|---|---|---|
| Page background | `--color-surface` | `--color-canvas` | `#0f1114` |
| Raised surface | `--color-surface-raised` | `--color-panel` | `#171a1f` |
| Text | `--color-ink` | `--color-text` | `#e6e8eb` |
| Muted text | `--color-ink-muted` | `--color-text-soft` | `#9aa3ae` |
| Border | `--color-border` | `--color-line` | `#2a2f37` |
| Control border | `--color-border-strong` | `--color-line-strong` | `#68717d` |
| Primary action | `--color-brand` | `--color-action` | `#7aa2ff` |
| Text on primary | `--color-on-brand` | `--color-on-action` | `#0f1114` |
| Accent surface | `--color-accent` | `--color-action-tint` | `#1a2540` |
| Link | `--color-link` | `--color-action` | `#7aa2ff` |
| Danger | `--color-danger` | `--color-alert` | `#ff7b72` |
| Overlay scrim | `--color-scrim` | — | `rgba(0, 0, 0, 0.6)` |

## Status

| Status | Foreground | Value | Background | Value |
|---|---|---|---|---|
| neutral | `--status-neutral` | `#9aa3ae` | `--status-neutral-bg` | `#22262d` |
| info | `--status-info` | `#7aa2ff` | `--status-info-bg` | `#1a2540` |
| success | `--status-success` | `#4cc38a` | `--status-success-bg` | `#12301f` |
| warning | `--status-warning` | `#e0b341` | `--status-warning-bg` | `#33290d` |
| danger | `--status-danger` | `#ff7b72` | `--status-danger-bg` | `#3a1614` |

The status mapping is the same as in the root `DESIGN.md`.

## Typography

Same as the default system: system sans stack, monospace for code, no web fonts.

## Spacing & shapes

Same as the default system. The only shadow is `--shadow-overlay`, `0 8px 24px rgba(0, 0, 0, 0.5)`.

## Components

The component files in `design-systems/default/components/` use roles only and need no dark copy.

## Do's and Don'ts

### Do
- Mark the frame root with `data-design-system="dark"` and style inside with roles.
### Don't
- Do not write literal colours inside a dark frame.
- Do not use pure black or pure white for surfaces or text.
