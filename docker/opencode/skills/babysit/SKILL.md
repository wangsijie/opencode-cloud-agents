---
name: babysit
description: Automatically monitor and babysit a Pull Request (PR). Checks for CI failures and performs dark repairs, processes review comments (fixing actionable items and declining off-topic/mainline-deviating requests), and resolves merge conflicts with master/main.
---

# PR Babysitter (`babysit`)

This skill enables OpenCode to act as an automated PR babysitter. It monitors a Pull Request, handles CI failures with automated ("dark") repairs, resolves actionable review comments while guarding against scope creep, and resolves merge conflicts with the target branch (`master` / `main`).

## Initialization & PR Discovery

1. **Identify Target PR**:
   - If a PR number or branch is explicitly provided (e.g., `/babysit #42` or `babysit branch-name`), target that PR.
   - Otherwise, detect the PR associated with the current git branch:
     ```bash
     gh pr view --json number,title,state,headRefName,baseRefName,mergeable,mergeStateStatus,url
     ```
   - If no open PR exists for the current branch, notify the user and ask for a PR number or offer to create one using `gh pr create`.

2. **Retrieve Context**:
   - Record head branch name, base branch name (e.g., `master` or `main`), mergeability state, and CI status.

---

## Execution Workflow

### Phase 1: CI Status Check & "Dark Repair"

1. **Check CI Run Status**:
   ```bash
   gh pr checks
   ```
2. **Handle Failing or Errored Checks**:
   - If any CI checks have failed:
     ```bash
     gh run list --branch <headRefName> --limit 5
     gh run view --log-failed <run-id>
     ```
   - Inspect failure logs to diagnose the precise root cause (e.g. type errors, failing unit tests, lint violations, missing dependencies, build script errors).
   - **Perform Dark Repair**:
     - Directly fix the failing code/configuration in the codebase.
     - Do not prompt the user for routine fixes (e.g. broken assertions, syntax errors, type fixes, formatting).
     - Verify the fix locally before committing (e.g. `pnpm run typecheck` or test suite).
     - Commit the fix:
       ```bash
       git add .
       git commit -m "fix(ci): dark repair failing check in run <run-id>"
       git push origin <headRefName>
       ```

---

### Phase 2: Review Comments Processing & Scope Guarding

1. **Retrieve PR Comments and Reviews**:
   ```bash
   # Get review comments on code
   gh api /repos/{owner}/{repo}/pulls/{pr_number}/comments
   # Get general PR comments and reviews
   gh pr view --json comments,reviews
   ```

2. **Evaluate Unhandled Comments**:
   For each actionable comment or review feedback:

   - **Scope Guard**:
     - **ACCEPT**: Bug fixes, code style alignment, minor requested refactoring, missing test cases, typos, parameter tweaks directly related to the PR's purpose.
     - **REJECT**: Off-topic feature requests, large unrelated architectural refactorings, requests to modify unrelated modules, unnecessary scope expansions, or changes contradicting codebase standards (anything that drifts off the PR's main line).

   - **Action for ACCEPTED Comments**:
     - Implement the requested changes in the code.
     - Run local checks (`pnpm run typecheck` / test suite).
     - Commit and push:
       ```bash
       git add .
       git commit -m "fix(review): address comment by @<author>"
       git push origin <headRefName>
       ```
     - Reply to the PR comment:
       ```bash
       gh api -X POST /repos/{owner}/{repo}/pulls/comments/{comment_id}/replies -f body="Fixed in commit $(git rev-parse --short HEAD)."
       ```

   - **Action for REJECTED Comments**:
     - **Do NOT implement the change**.
     - Reply politely on GitHub explaining the decision to decline:
       ```bash
       gh api -X POST /repos/{owner}/{repo}/pulls/comments/{comment_id}/replies -f body="Declined: This request is out of scope for the current PR as it introduces changes unrelated to the main objective. Please open a separate issue or PR for this request."
       ```

---

### Phase 3: Conflict Check & Resolution

1. **Inspect Mergeability**:
   ```bash
   gh pr view --json mergeable,mergeStateStatus,baseRefName
   ```

2. **Resolve Merge Conflicts**:
   - If `mergeable` is `DIRTY` or conflicts exist with the base branch (`master` / `main`):
     ```bash
     git fetch origin <baseRefName>
     git rebase origin/<baseRefName>
     # Or if preferred by repo conventions: git merge origin/<baseRefName>
     ```
   - Resolve conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) carefully:
     - Retain intended changes from both branches without breaking existing functionality.
   - Run verification locally:
     ```bash
     pnpm run typecheck
     ```
   - Complete rebase/merge and push:
     ```bash
     git push --force-with-lease origin <headRefName> # for rebase
     # or: git push origin <headRefName> # for merge
     ```

---

### Phase 4: Final Re-Verification & Summary

1. **Re-Check CI Status**:
   - Run `gh pr checks` to verify that newly pushed commits triggered or passed CI.

2. **Summarize Results**:
   Provide a concise report covering:
   - **PR Status**: Title, URL, and current status.
   - **CI Repairs**: Details of any dark repairs made for failing checks.
   - **Review Comments**: List of accepted & fixed comments vs. rejected off-topic comments (with rationale).
   - **Merge Conflicts**: Confirmation of successful rebase/merge with target branch.
