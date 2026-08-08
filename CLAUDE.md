# CLAUDE.md

This repository is a personal fork with a rebase-heavy workflow. The full development rules live in **AGENTS.md** — read it before working here.

Two rules that matter most:

- **Never leave the main checkout dirty.** `personal` is continuously rebased onto `main` (which tracks upstream), and stray changes in the main checkout block that.
- **Always work in a git worktree** under `.worktrees/`, branched off `personal`, and land changes on `personal` via PR.
