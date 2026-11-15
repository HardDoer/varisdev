---
name: doctor
description: Audit the current repository's AGENTS.md files, agent instructions, skills, and working conventions. Find conflicting, outdated, duplicated, or missing guidance and propose concrete fixes grounded in the project.
---

# Repository doctor

Check whether the repository gives agents clear, accurate instructions for working in it. Run the audit with `/skill:doctor`; arguments can focus it on a directory, instruction file, or workflow. `prompt-audit` is an alias for the same audit.

Start inspecting the repository immediately. Use the active working directory and repository or worktree root as the scope. The skill's installation directory is only where these instructions live. Installation health, PATH, updates, accounts, and machine settings are outside this audit.

## Find the guidance

- Identify the repository root, current directory, and relevant project areas. Use the repository's file inventory to locate root and nested `AGENTS.md` files and any discovered `AGENTS.override.md`, `CLAUDE.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`, agent profiles, and `SKILL.md` files. Exclude dependencies, generated output, vendored code, and unrelated repositories unless their instructions are part of the requested scope. Include relevant local instruction files even when they are untracked.
- Read applicable instructions and their linked convention guides. Include ancestor, personal, or workspace instructions already supplied in the active context when they affect the repository. Follow specific references as needed; do not scan the user's home directory for more configuration.
- Map each instruction source to its intended scope. Distinguish files actually loaded in the session from files merely present in the repository. VarisDev/Pi selects the first readable instruction file in each directory in this order: `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`. Inspect shadowed files for drift without treating their differences as active conflicts.
- Automatic repository context follows the session working directory's ancestry. Reading a file in a child directory does not automatically load that directory's instructions. When moving guidance into a nested instruction file, retain an explicit reference from a source the agent does load. Account for any supplied personal, workspace, or selected agent instructions; do not infer active loading from their presence on disk.
- For large repositories, group instructions by project area and inspect the relevant manifests, automation, and representative files. State any parts left uninspected. A focused request should stay focused.

## Check the working conventions

Verify claims against current project files before reporting them. Read the evidence needed for each finding rather than treating every source file as a review target.

- **Conflicting rules:** compare requirements across applicable instructions, skills, and contributing guides. Check precedence and scope first; an intentional local override is not a conflict. Look for incompatible review, testing, approval, commit, and release requirements or instructions that prevent completing the requested work.
- **Stale guidance:** verify paths, script names, commands, configuration keys, tooling, and architecture claims against manifests, task definitions, CI, and the current directory structure. Follow links and check whether referenced files and commands still exist.
- **Workflow gaps:** check whether build, test, formatting, review, and release guidance identifies the project's actual entry points and relevant platform constraints. Flag an omission only when it leaves a concrete decision unclear or has caused observed friction. Do not impose a generic checklist or recommend a new tool just because it is absent.
- **Duplication and context cost:** identify repeated rules across instruction files and long sections that restate discoverable project facts. Keep stable, consequential conventions easy to find. Propose consolidating duplicate guidance and moving detailed procedures into a relevant skill or linked guide, with an explicit pointer where needed. Do not equate file bytes with tokens or assume every skill body is always loaded.
- **Scope and placement:** check whether instructions for one package or task unnecessarily govern the whole repository, whether personal copies have drifted from shared guidance, and whether referenced instructions can actually be discovered. Preserve meaningful local differences.
- **Skills and agent profiles:** compare descriptions with their bodies and the workflows they invoke. Check for obsolete tool names, unsupported options, incorrect path assumptions, recursive delegation, and instructions that contradict repository conventions. Review only profiles and skills relevant to the audit.
- **Clarity and usefulness:** find ambiguous requirements, unexplained exceptions, and rules whose requested outcome cannot be verified. Explain the practical consequence of each issue. Personal style preferences and deliberate project choices are not defects.

Inspect command definitions before deciding to run anything. Use existing project checks only when needed to resolve a finding, with a process deadline and child-process cleanup. Do not execute an obsolete command merely to prove it fails, or run installers, deployments, or release actions as diagnostic checks.

## Report and repair

Return a concise, prioritized set of actionable findings. For each finding include:

1. The instruction file and heading or line reference, with the relevant rule.
2. The project evidence that contradicts it or demonstrates the gap, and its practical effect.
3. A concrete replacement, deletion, or move, including the destination and any reference needed to keep moved guidance discoverable.

Give exact proposed edits or a short diff for repairs. Complete the investigation and prepare the edits before asking any question needed to resolve a genuine ambiguity. If the user requested fixes, apply the supported edits within that scope; an audit request by itself calls for findings and proposed edits. Preserve unrelated instructions and existing user changes.

Briefly state what was inspected and any material limits. If no actionable problems were found, say so without inventing cleanup work. After edits, recheck the affected references and conventions and run only the relevant project checks.
