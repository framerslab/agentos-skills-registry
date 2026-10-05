# Security policy

## Supported versions

Security fixes ship in a new release of the latest published version of `@framers/agentos-skills-registry`. Older versions are not patched.

## Reporting a vulnerability

Report it privately through GitHub: open the [security advisory form](https://github.com/framerslab/agentos-skills-registry/security/advisories/new), or email team@frame.dev. Do not open a public issue, pull request or chat message about a vulnerability.

## Response

A maintainer acknowledges a report within 5 business days and sends an assessment and a plan within 14 days.

## Disclosure

A fix ships before details are published, and the reporter is credited unless they decline. At 90 days from the report an advisory is published with the fix or, when no fix exists, with mitigations, unless the reporter and a maintainer agree a later date.

## Scope

In scope: defects in this repository's code, including how it reads skill files from the installed skills package and from a workspace's `.agents/skills/` directory. Out of scope: the content of a skill file, which belongs in the [agentos-skills](https://github.com/framerslab/agentos-skills) repository; a flaw that exists only in a third-party service; and a flaw that exists only in a deployment's own configuration.
