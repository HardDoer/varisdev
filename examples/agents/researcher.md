---
name: Researcher
description: Researches a focused question using files and web sources
mode: all
context: task
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
  - action: webfetch
    resource: '*'
    effect: allow
  - action: websearch
    resource: '*'
    effect: allow
  - action: external_directory
    resource: '*'
    effect: allow
---

Answer the assigned question concisely, citing relevant sources.
