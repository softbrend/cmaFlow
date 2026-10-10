"""
Commit and push the SME Owner-TAM updates to GitHub:
  * Position in the business (15 options) and decision-making involvement
    (5 levels) on the sign-up form, and asked once on the next login for
    evaluators who registered earlier.
  * Admin summaries by decision-making level and position, a "primary SME
    decision-makers only" filter on the TAM report, and the earlier
    Business Category (completed vs not completed) summary.

Run from anywhere:
    python scripts\\push_sme_tam_role_questions.py

It checks the files, syntax-checks the JavaScript (if Node is installed),
then commits only these files and pushes to the current branch. Render
re-runs db/schema.sql on deploy, which adds the new database columns
safely (it can run any number of times).
"""
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent  # D:\CMAFlow-Balala

# file -> text that must be present (proves the update is in the file)
FILES = {
    # Business Category summary (earlier today)
    "services/smeTamCategorySummary.js": "buildDecisionMakerSummary",
    "views/dashboard/_sme-tam-category-summary.ejs": "Primary DMs",
    # Position + decision-making questions
    "services/smeTamRespondentProfile.js": "Other Business Decision-Maker",
    "middleware/respondentProfileGate.js": "respondentProfileGate",
    "server.js": "respondentProfileGate",
    "db/schema.sql": "decision_authority",
    "routes/auth.js": "/smeOwnerTam/profile",
    "routes/admin.js": "PRIMARY_AUTHORITY_VALUES",
    "services/tamEvaluation.js": "decisionAuthorityFilter",
    "services/adminAccounts.js": "respondent_position",
    "views/auth/_smeTam-respondent-fields.ejs": "decision_authority",
    "views/auth/smeOwnerTam-signup.ejs": "_smeTam-respondent-fields",
    "views/auth/smeOwnerTam-profile.ejs": "Two quick questions",
    "views/partials/sidebar.ejs": "My Role in the Business",
    "views/dashboard/_sme-tam-decision-summary.ejs": "decision-making involvement",
    "views/dashboard/admin-sme-tam-accounts.ejs": "_sme-tam-decision-summary",
    "views/dashboard/admin-sme-tam-evaluations.ejs": "respondents=primary",
    "views/dashboard/admin-sme-tam-evaluation-detail.ejs": "Decision-Making Involvement",
    "scripts/push_sme_tam_role_questions.py": "push_sme_tam_role_questions",
}

JS_FILES = [f for f in FILES if f.endswith(".js")]

COMMIT_MESSAGE = """Add position and decision-making questions for SME Owner-TAM evaluators

- Sign-up form: position in the business (15 standard options, free text for
  "Other Business Decision-Maker") and level of involvement in business
  decision-making (5 levels).
- Evaluators who registered earlier are asked both questions once on their
  next login (/smeOwnerTam/profile) before continuing; they can update their
  answers later from "My Role in the Business" in the sidebar.
- New sme_accounts columns: respondent_position, respondent_position_other,
  decision_authority, respondent_profile_updated_at (idempotent schema).
- Admin: summary by decision-making level and position (completed vs not
  completed), position/decision columns on Manage SME Owner-TAM Evaluators,
  profile shown on the evaluation detail page, and a "Primary SME
  decision-makers only" filter (Primary, Joint, Departmental) on the TAM report.
- Business Category summary (completed vs not completed) on the SME
  Owner-TAM admin pages, with a primary decision-maker column.

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

    for rel, marker in FILES.items():
        path = REPO / rel
        if not path.exists():
            sys.exit(f"Missing file: {rel}")
        if marker not in path.read_text(encoding="utf-8"):
            sys.exit(f"{rel} does not contain the update (looked for '{marker}').")
        print(f"OK  {rel}")

    if shutil.which("node"):
        for rel in JS_FILES:
            run(["node", "--check", rel])
        print("JavaScript syntax OK\n")
    else:
        print("Node not found on PATH - skipping syntax check.\n")

    if run(["git", "rev-parse", "--is-inside-work-tree"], check=False).returncode != 0:
        sys.exit("This folder is not a git repository.")

    branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"]).stdout.strip()
    print(f"Current branch: {branch}\n")

    # Include the earlier category-summary push script if it exists, so it's tracked too.
    extra = [p for p in ["scripts/push_sme_tam_category_summary.py"] if (REPO / p).exists()]
    run(["git", "add", "--"] + list(FILES.keys()) + extra)

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

    print("\nDone - pushed to GitHub. Render will redeploy (and add the new columns) if auto-deploy is on.")


if __name__ == "__main__":
    main()
