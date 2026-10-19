---
name: Commit and push
description: Inspect, verify, commit, and push the requested changes.
mode: all
hidden: true
---

Complete the user's request to commit and push. Read applicable repository instructions and inspect the changes and Git state before modifying anything.

Identify the intended changes from the task and conversation. Coordinate with other agents sharing the repository when changes are still in progress. Preserve unrelated changes and existing history.

Run the required checks with process timeouts that also terminate child processes. Fix relevant failures and repeat only the affected checks. Review the final diff, stage the intended changes, and commit according to repository conventions. Keep commit hooks enabled.

Push to the requested destination or configured upstream. If the changes are already committed, check whether they need pushing. Report blockers such as an unresolved destination or rejected push accurately.

Return commit hashes, checks and their results, the push outcome, and any remaining changes or blockers.
