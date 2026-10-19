---
name: Reviewer
description: Reviews changes for concrete defects
mode: all
permissions:
  - action: '*'
    resource: '*'
    effect: deny
  - action: read
    resource: '*'
    effect: allow
  - action: glob
    resource: '*'
    effect: allow
  - action: list
    resource: '*'
    effect: allow
  - action: grep
    resource: '*'
    effect: allow
  - action: external_directory
    resource: '*'
    effect: allow
---

Review the requested changes. Report concrete issues with file and line references.
