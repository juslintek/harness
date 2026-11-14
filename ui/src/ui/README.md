# Shared components

Import from `ui/atoms`, `ui/molecules`, `ui/organisms`; each has an `index.ts` that exports every
file in its folder, and the CSS sits beside the file. Atoms are one element. Molecules are a few
atoms working as one unit. Organisms are a screen section used by two or more features. A piece one
feature uses stays in `features/<name>/`; when a second feature needs it, move it up a level.
Utility classes (`.mono`, `.stack`, `.form-row`, `.row-actions`, `.page-stack`) live in `src/styles.css`.

| Component                                                                                                                         | Level     | Recto file                |
| --------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------- |
| Button                                                                                                                            | atoms     | button                    |
| ButtonLink (a link that looks like a button)                                                                                      | atoms     | button                    |
| StatusBadge, statusWord (kinds: approval, budget, candidate, guard, hire, run, task, wakeup)                                      | atoms     | status-badge              |
| Switch                                                                                                                            | atoms     | switch                    |
| Checkbox                                                                                                                          | atoms     | checkbox                  |
| Help (`small` for a caption line)                                                                                                 | atoms     | help                      |
| Meter                                                                                                                             | atoms     | meter                     |
| CountBadge, Dot                                                                                                                   | atoms     | nav-item, conn-state      |
| CopyButton (`label` is both the visible words and the accessible name; `tone`)                                                    | atoms     | none (button, secondary)  |
| Field                                                                                                                             | molecules | field                     |
| Panel                                                                                                                             | molecules | panel                     |
| Dialog                                                                                                                            | molecules | dialog                    |
| ConfirmDialog                                                                                                                     | molecules | dialog (confirm)          |
| ConfirmButton (button that asks first)                                                                                            | molecules | dialog (confirm)          |
| State                                                                                                                             | molecules | state                     |
| EmptyPanel (State plus action buttons)                                                                                            | molecules | empty-panel               |
| Notice (`standing`: no live role)                                                                                                 | molecules | notice                    |
| Steps                                                                                                                             | molecules | steps                     |
| Tabs (`count`, `countTone`; scrolls inside its own box on a narrow screen)                                                        | molecules | tabs, tab                 |
| NavItem                                                                                                                           | molecules | nav-item                  |
| ConnState                                                                                                                         | molecules | conn-state                |
| AgentsState, AgentsToggle                                                                                                         | molecules | agents-state              |
| OrgSwitcher                                                                                                                       | molecules | org-switcher              |
| CodeBlock (`copy={false}` hides the button; `prompt` adds `$`; the button reads `Copy <label>`)                                   | molecules | code-block                |
| TableBox (`stack`: rows become lines on a phone)                                                                                  | molecules | data-table                |
| BudgetMeter                                                                                                                       | molecules | meter                     |
| QueryChips                                                                                                                        | molecules | none (suggested searches) |
| Sidebar                                                                                                                           | organisms | sidebar                   |
| TopBar                                                                                                                            | organisms | top-bar                   |
| AppShell                                                                                                                          | organisms | shell-states artboards    |
| ApprovalCard (`runButton` adds an Open run link), approvalTitle, DecidableApprovalCard (the card with its Deny and Approve calls) | organisms | approval-card             |
| useNow, countdown, createHalt, NavCountsSource, nav helpers, useCrumbName (names the page in the breadcrumb)                      | organisms | none (shell plumbing)     |

`RunRow` and `RunRowHead` (Recto `run-row`) live in `features/runs/`: only Runs draws them. Now lists
wakeups, not runs, and has no run title, cost or tokens for people who are not instance admins.
