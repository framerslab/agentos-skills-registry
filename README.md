<p align="center">
  <a href="https://agentos.sh"><img src="logos/agentos-primary-no-tagline-transparent-2x.png" alt="AgentOS" height="56" /></a>
  &nbsp;&nbsp;&nbsp;
  <a href="https://frame.dev"><img src="logos/frame-logo-green-no-tagline.svg" alt="Frame.dev" height="36" /></a>
</p>

# @framers/agentos-skills-registry

**Catalog SDK** for querying and loading AgentOS skills.

[![npm](https://img.shields.io/npm/v/@framers/agentos-skills-registry?logo=npm&color=cb3837)](https://www.npmjs.com/package/@framers/agentos-skills-registry)

```bash
npm install @framers/agentos-skills-registry
```

For the **skill content** (SKILL.md files), see [`@framers/agentos-skills`](https://github.com/framerslab/agentos-skills).

## Ecosystem

| Package | Role |
| --- | --- |
| [`@framers/agentos-skills`](https://github.com/framerslab/agentos-skills) | Content — 88 [SKILL.md files](https://github.com/framerslab/agentos-skills/tree/master/registry/curated) + [registry.json](https://github.com/framerslab/agentos-skills/blob/master/registry.json) |
| [`@framers/agentos-skills-registry`](https://github.com/framerslab/agentos-skills-registry) | Catalog SDK — query helpers, lazy loaders, factories |
| [`@framers/agentos`](https://github.com/framerslab/agentos/tree/master/src/cognition/skills) | Engine — [SkillLoader](https://github.com/framerslab/agentos/blob/master/src/cognition/skills/SkillLoader.ts), [SkillRegistry](https://github.com/framerslab/agentos/blob/master/src/cognition/skills/SkillRegistry.ts), SkillSnapshot |

> This layout mirrors the extensions ecosystem:
> [`@framers/agentos-extensions`](https://github.com/framerslab/agentos-extensions) (content) + [`@framers/agentos-extensions-registry`](https://github.com/framerslab/agentos-extensions-registry) (SDK).

| Package | Role | What | Runtime Code | Dependencies |
| --- | --- | --- | :---: | --- |
| [**@framers/agentos/skills**](https://github.com/framerslab/agentos/tree/master/src/cognition/skills) | **Engine** | [SkillLoader](https://github.com/framerslab/agentos/blob/master/src/cognition/skills/SkillLoader.ts), [SkillRegistry](https://github.com/framerslab/agentos/blob/master/src/cognition/skills/SkillRegistry.ts), [path utils](https://github.com/framerslab/agentos/blob/master/src/cognition/skills/paths.ts) | Yes | `yaml` |
| [**@framers/agentos-skills**](https://github.com/framerslab/agentos-skills) | **Content** | 88 [SKILL.md files](https://github.com/framerslab/agentos-skills/tree/master/registry/curated) + [registry.json](https://github.com/framerslab/agentos-skills/blob/master/registry.json) index | No | None |
| [**@framers/agentos-skills-registry**](https://github.com/framerslab/agentos-skills-registry) | **Catalog SDK** | SKILLS_CATALOG, query helpers, lazy loaders, factories | Yes | `agentos-skills`, `yaml` |

## Quick Start

### 1. Browse the catalog (zero peer deps)

```typescript
import {
  SKILLS_CATALOG,
  searchSkills,
  getSkillsByCategory,
  getSkillByName,
} from '@framers/agentos-skills-registry/catalog';

// Full-text search
const matches = searchSkills('github');
console.log(matches.map((s) => `${s.name}: ${s.description}`));

// By category
const devSkills = getSkillsByCategory('developer');
console.log(`${devSkills.length} developer skills`);

// By name
const gh = getSkillByName('github');
console.log(gh?.requiredSecrets); // ['github.token']
```

### 2. Lazy-load a skill on demand

```typescript
import { loadSkillByName } from '@framers/agentos-skills-registry';

const skill = await loadSkillByName('github');
if (skill) {
  console.log(skill.content); // SKILL.md body for prompt injection
  console.log(skill.metadata?.emoji); // "octopus"
}
```

### 3. Build a SkillSnapshot (requires @framers/agentos)

```typescript
import { createCuratedSkillSnapshot } from '@framers/agentos-skills-registry';

const snapshot = await createCuratedSkillSnapshot({
  skills: ['github', 'web-search', 'notion'],
  platform: 'darwin',
});

// Inject into agent prompt
console.log(snapshot.prompt);
```

### 4. Workspace skill discovery

```typescript
import {
  discoverWorkspaceSkills,
  mergeWithWorkspaceSkills,
  SKILLS_CATALOG,
} from '@framers/agentos-skills-registry';

// Scan .agents/skills/ for workspace-local skills
const workspace = await discoverWorkspaceSkills();

// Merge with curated (workspace takes priority on name collision)
const merged = mergeWithWorkspaceSkills(SKILLS_CATALOG, workspace);
```

## Sub-exports

| Entry Point                                            | What                                                | Peer Deps                     |
| ------------------------------------------------------ | --------------------------------------------------- | ----------------------------- |
| `@framers/agentos-skills-registry`                     | Full API: catalog + factories + workspace discovery | `@framers/agentos` (optional) |
| `@framers/agentos-skills-registry/catalog`             | `SKILLS_CATALOG`, query helpers, lazy loaders       | None                          |
| `@framers/agentos-skills-registry/workspace-discovery` | Workspace skill scanning + merging                  | None                          |

## API Reference

### Catalog Queries

- `SKILLS_CATALOG` -- Sorted array of all curated + community skill entries
- `searchSkills(query)` -- Full-text search across names, descriptions, tags
- `getSkillsByCategory(category)` -- Filter by category
- `getSkillByName(name)` -- Single skill lookup
- `getAvailableSkills(installedTools)` -- Filter by available tools
- `getCategories()` -- List unique categories
- `getSkillsByTag(tag)` -- Filter by tag
- `getCuratedSkills()` / `getCommunitySkills()` / `getAllSkills()` -- Source filters
- `getSkillEntries(names)` -- Filter by name list (`'all'` | `'none'` | `string[]`)

### Lazy Loading

- `loadSkillByName(name)` -- Load and parse a single SKILL.md by name
- `loadSkillsByNames(names)` -- Parallel load multiple skills
- `createLocalSkillProxy(relativePath, displayName)` -- Factory for lazy loading

### Factory Functions (requires @framers/agentos)

- `createCuratedSkillRegistry(options?)` -- Create a live `SkillRegistry` with selected curated skills
- `createCuratedSkillSnapshot(options?)` -- Build a `SkillSnapshot` ready for prompt injection

### Path Helpers

- `getBundledCuratedSkillsDir()` -- Absolute path to `@framers/agentos-skills/registry/curated/`
- `getBundledCommunitySkillsDir()` -- Absolute path to `@framers/agentos-skills/registry/community/`

### Workspace Discovery

- `discoverWorkspaceSkills(options?)` -- Scan `.agents/skills/` for workspace-local skills
- `mergeWithWorkspaceSkills(registry, workspace)` -- Merge with priority to workspace
- `parseSkillFrontmatter(content)` -- Parse YAML frontmatter from skill content

## License

Apache 2.0 — see [LICENSE](https://github.com/framerslab/agentos-skills-registry/blob/master/LICENSE).
