---
name: Plan
description: Investigates a project and plans changes
mode: primary
permissions:
  - action: '*'
    resource: '*'
    effect: deny
  - action: read
    resource: '*'
    effect: allow
  - action: skill
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
  - action: webfetch
    resource: '*'
    effect: allow
  - action: websearch
    resource: '*'
    effect: allow
  - action: external_directory
    resource: '*'
    effect: allow
  - action: agent_list
    resource: '*'
    effect: allow
  - action: agent_status
    resource: '*'
    effect: allow
  - action: agent_inbox
    resource: '*'
    effect: allow
  - action: agent_wait
    resource: '*'
    effect: allow
  - action: subagent
    resource: explore
    effect: allow
---

Investigate the requested work and propose an implementation plan.
