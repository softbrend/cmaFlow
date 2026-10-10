"""
Commit and push the revised "Not yet completed" layout on the SME Owner-TAM
admin pages (full-width list under each business category).

    python scripts\\push_not_completed_layout.py
"""
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
FILES = ["views/dashboard/_sme-tam-category-summary.ejs", "scripts/push_not_completed_layout.py"]
MESSAGE = """Show "Not yet completed" evaluators full-width under each business category

The names list was a narrow last column that squeezed the text. It is now a
full-width row of cards under each category (name, username, questionnaire
progress, position and decision-making level), open by default.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KboqKdVcLtBWRaPByPr9Ln
"""


def run(cmd, check=True):
    print("> " + " ".join(cmd))
    r = subprocess.run(cmd, cwd=REPO, text=True, capture_output=True)
    if r.stdout.strip():
        print(r.stdout.strip())
    if r.stderr.strip():
        print(r.stderr.strip())
    if check and r.returncode != 0:
        sys.exit(f"\nStopped: command failed ({r.returncode}).")
    return r


if "not-completed-row" not in (REPO / FILES[0]).read_text(encoding="utf-8"):
    sys.exit("The summary file does not contain the new layout.")
branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"]).stdout.strip()
run(["git", "add", "--"] + FILES)
if run(["git", "diff", "--cached", "--name-only"]).stdout.strip():
    run(["git", "commit", "-m", MESSAGE])
else:
    print("Nothing new to commit. Pushing anyway...")
if run(["git", "push", "origin", branch], check=False).returncode != 0:
    sys.exit(f"\nPush failed. Run: git pull --rebase origin {branch}  then run this script again.")
print("\nDone - pushed. Render will redeploy if auto-deploy is on.")
