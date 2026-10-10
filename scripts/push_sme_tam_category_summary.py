"""
Commit and push the SME Owner-TAM "Business Category summary" update
(completed vs not completed) to GitHub.

Run from anywhere:
    python scripts\\push_sme_tam_category_summary.py

What it does:
  1. Checks the five changed/new files exist and contain the new code.
  2. Syntax-checks the two JavaScript files with `node --check` (if Node is installed).
  3. git add (only these five files) -> git commit -> git push to the current branch.
"""
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent  # D:\CMAFlow-Balala

FILES = {
    "services/smeTamCategorySummary.js": "buildCategorySummary",
    "views/dashboard/_sme-tam-category-summary.ejs": "Summary by SME business category",
    "views/dashboard/admin-sme-tam-accounts.ejs": "_sme-tam-category-summary",
    "views/dashboard/admin-sme-tam-evaluations.ejs": "_sme-tam-category-summary",
    "routes/admin.js": "smeTamCategorySummary",
}

COMMIT_MESSAGE = """Add Business Category summary (completed vs not completed) for SME Owner-TAM evaluators

- New services/smeTamCategorySummary.js groups SME Owner-TAM accounts by
  SME business category and counts completed / questionnaire open / not started.
- New partial views/dashboard/_sme-tam-category-summary.ejs (KPI tiles,
  per-category table with completion rate, list of who has not completed,
  categories with no evaluator yet).
- Shown on /admin/sme-tam-accounts and /admin/sme-tam-evaluations.
- Accounts table gets a per-account TAM evaluation status badge.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KboqKdVcLtBWRaPByPr9Ln
"""


def run(cmd, check=True):
    print("> " + " ".join(cmd))
    result = subprocess.run(cmd, cwd=REPO, text=True, capture_output=True)
    if result.stdout.strip():
        print(result.stdout.strip())
    if result.stderr.strip():
        print(result.stderr.strip())
    if check and result.returncode != 0:
        sys.exit(f"\nStopped: command failed ({result.returncode}).")
    return result


def main():
    print(f"Repository: {REPO}\n")

    # 1. Verify files
    for rel, marker in FILES.items():
        path = REPO / rel
        if not path.exists():
            sys.exit(f"Missing file: {rel}")
        if marker not in path.read_text(encoding="utf-8"):
            sys.exit(f"{rel} does not contain the update (looked for '{marker}').")
        print(f"OK  {rel}")

    # 2. Syntax-check the JS files
    if shutil.which("node"):
        for rel in ("services/smeTamCategorySummary.js", "routes/admin.js"):
            run(["node", "--check", rel])
        print("JavaScript syntax OK\n")
    else:
        print("Node not found on PATH - skipping syntax check.\n")

    # 3. Git: add, commit, push
    if run(["git", "rev-parse", "--is-inside-work-tree"], check=False).returncode != 0:
        sys.exit("This folder is not a git repository.")

    branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"]).stdout.strip()
    print(f"Current branch: {branch}\n")

    run(["git", "add", "--"] + list(FILES.keys()))

    staged = run(["git", "diff", "--cached", "--name-only"]).stdout.strip()
    if not staged:
        print("Nothing new to commit (already committed). Pushing anyway...")
    else:
        run(["git", "commit", "-m", COMMIT_MESSAGE])

    push = run(["git", "push", "origin", branch], check=False)
    if push.returncode != 0:
        print("\nPush failed. If the remote has newer commits, run:")
        print(f"    git pull --rebase origin {branch}")
        print("then run this script again.")
        sys.exit(1)

    print("\nDone - pushed to GitHub. Render will redeploy automatically if auto-deploy is on.")


if __name__ == "__main__":
    main()
