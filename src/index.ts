// @ts-nocheck
/**
 * @fileoverview AgentOS Skills Registry — Catalog SDK.
 *
 * Provides the programmatic catalog, query helpers, and lazy-loading factory
 * functions for the curated SKILL.md prompt modules.
 *
 * **Ecosystem layout** (mirrors extensions):
 * ```
 * @framers/agentos/cognition/skills     ← Engine (SkillLoader, SkillRegistry)
 * @framers/agentos-skills               ← Content (88 SKILL.md files + registry.json)
 * @framers/agentos-skills-registry      ← Catalog SDK (this package)
 * ```
 *
 * Content (SKILL.md files + registry.json) lives in `@framers/agentos-skills`.
 * This SDK reads that content at runtime via `createRequire().resolve()`.
 *
 * `@framers/agentos` is an **optional peer dependency** — the catalog helpers
 * (re-exported from `./catalog.js`) work without it.  Only the factory
 * functions that produce a live `SkillRegistry` or `SkillSnapshot` need it,
 * and they load it lazily via dynamic `import()`.
 *
 * @module @framers/agentos-skills-registry
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';

// ── Local mirror types (avoid eager import of @framers/agentos) ─────────────
// These are structurally compatible with the canonical types from
// `@framers/agentos/cognition/skills`.  Consumers who depend on the peer dep can simply
// cast or use the canonical imports.

/** @see SkillSnapshot in @framers/agentos/cognition/skills */
export interface SkillSnapshot {
  prompt: string;
  skills: Array<{ name: string; primaryEnv?: string }>;
  resolvedSkills?: unknown[];
  version?: number;
  createdAt: Date;
}

/** @see SkillsConfig in @framers/agentos/cognition/skills */
export interface SkillsConfig {
  allowBundled?: string[];
  load?: { extraDirs?: string[]; watch?: boolean; watchDebounceMs?: number };
  install?: { preferBrew: boolean; nodeManager: 'npm' | 'pnpm' | 'yarn' | 'bun' };
  entries?: Record<
    string,
    {
      enabled?: boolean;
      apiKey?: string;
      env?: Record<string, string>;
      config?: Record<string, unknown>;
    }
  >;
}

/** @see SkillEligibilityContext in @framers/agentos/cognition/skills */
export interface SkillEligibilityContext {
  platforms: string[];
  hasBin: (bin: string) => boolean;
  hasAnyBin: (bins: string[]) => boolean;
  hasEnv?: (envVar: string) => boolean;
  note?: string;
}

// ── Re-export the programmatic catalog (zero heavy deps) ────────────────────

export {
  SKILLS_CATALOG,
  getSkillsByCategory,
  getSkillByName,
  getAvailableSkills,
  getCategories,
  getSkillsByTag,
  searchSkills,
  getCuratedSkills,
  getCommunitySkills,
  getAllSkills,
  getSkillEntries,
  createLocalSkillProxy,
  loadSkillFromAbsolutePath,
  loadSkillByName,
  loadSkillsByNames,
} from './catalog.js';
export type { SkillCatalogEntry, LoadedSkill, LoadedSkillFrontmatter } from './catalog.js';
import {
  getSkillEntries,
  loadSkillsByNames,
  type LoadedSkill,
  type LoadedSkillFrontmatter,
} from './catalog.js';
import type { SkillMetadata } from './schema-types.js';

// ── Re-export workspace skill discovery (Feature 3.5) ───────────────────────

export {
  discoverWorkspaceSkills,
  mergeWithWorkspaceSkills,
  parseSkillFrontmatter,
} from './workspace-discovery.js';
export type {
  SkillFrontmatter,
  WorkspaceDiscoveryOptions,
} from './workspace-discovery.js';

// ── Re-export registry.json schema types ────────────────────────────────────

export type {
  SkillInstallKind,
  SkillInstallSpec,
  SkillRequirements,
  SkillMetadata,
  SkillRegistryEntry,
  SkillsRegistryStats,
  SkillsRegistry,
} from './schema-types.js';

// ── Lazy loader for @framers/agentos ────────────────────────────────────────

/** Resolved module cache — loaded at most once per process. */
let _agentosSkillsMod: {
  SkillRegistry: new (config?: SkillsConfig) => {
    register(entry: {
      skill: { name: string; description: string; content: string };
      frontmatter: LoadedSkillFrontmatter;
      metadata?: SkillMetadata;
      sourcePath?: string;
      source?: string;
    }): boolean;
    loadFromDirs(dirs: string[]): Promise<number>;
    loadFromDir?(dir: string, options?: { source?: string }): Promise<number>;
    buildSnapshot(options?: {
      platform?: string;
      eligibility?: SkillEligibilityContext;
      filter?: string[];
      strict?: boolean;
      runtimeConfig?: Record<string, unknown>;
    }): SkillSnapshot;
  };
  extractMetadata?: (frontmatter: LoadedSkillFrontmatter) => SkillMetadata | undefined;
} | null = null;

async function requireAgentOS(): Promise<NonNullable<typeof _agentosSkillsMod>> {
  if (_agentosSkillsMod) return _agentosSkillsMod;

  try {
    // Dynamic import — only resolved when a consumer calls a factory function.
    const mod = await import('@framers/agentos/cognition/skills');
    _agentosSkillsMod = mod as unknown as NonNullable<typeof _agentosSkillsMod>;
    return _agentosSkillsMod;
  } catch {
    throw new Error(
      '@framers/agentos is required for createCuratedSkillRegistry() and ' +
        'createCuratedSkillSnapshot().  Install it:\n\n' +
        '  npm install @framers/agentos\n\n' +
        'Or use the lightweight catalog helpers (getSkillsByCategory, searchSkills, etc.) ' +
        'which have no peer-dep requirement.'
    );
  }
}

// ── Path helpers (resolve from @framers/agentos-skills content package) ──────

/**
 * Resolve the root of the `@framers/agentos-skills` content package.
 *
 * SKILL.md files and registry.json now live in the content package, not this
 * SDK package. This mirrors the extensions layout:
 * `@framers/agentos-extensions` (content) + `@framers/agentos-extensions-registry` (SDK).
 */
function resolveContentPackageRoot(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('@framers/agentos-skills/package.json');
    return path.dirname(pkgPath);
  } catch {
    // Monorepo fallback: content package is a sibling directory
    const __dirname = path.dirname(new URL(import.meta.url).pathname);
    const thisPackageRoot = path.resolve(__dirname, '..');
    return path.resolve(thisPackageRoot, '..', 'agentos-skills');
  }
}

/**
 * Resolve the path to `registry.json` in the content package.
 */
function resolveCatalogPath(): string {
  return path.join(resolveContentPackageRoot(), 'registry.json');
}

/**
 * Absolute path to the bundled curated skills directory.
 *
 * Resolves into `@framers/agentos-skills/registry/curated/`.
 * This directory can be passed to `SkillRegistry.loadFromDirs([dir])`.
 */
export function getBundledCuratedSkillsDir(): string {
  return path.join(resolveContentPackageRoot(), 'registry', 'curated');
}

/**
 * Absolute path to the bundled community skills directory.
 *
 * Resolves into `@framers/agentos-skills/registry/community/`.
 */
export function getBundledCommunitySkillsDir(): string {
  return path.join(resolveContentPackageRoot(), 'registry', 'community');
}

// ── Options ─────────────────────────────────────────────────────────────────

export type CuratedSkillsSelection = 'all' | 'none' | string[];

export interface CuratedSkillsOptions {
  /** Which curated skills to include. Default: 'all'. */
  skills?: CuratedSkillsSelection;
  /** Optional skills config (disable entries, env overrides, etc.). */
  config?: SkillsConfig;
  /** Platform filter for snapshot building. */
  platform?: string;
  /** Eligibility filter for snapshot building. */
  eligibility?: SkillEligibilityContext;
}

// ── Catalog types ───────────────────────────────────────────────────────────

export interface SkillsCatalogEntry {
  id: string;
  name: string;
  displayName?: string;
  version: string;
  path: string;
  description: string;
  category?: string;
  namespace?: string;
  verified: boolean;
  verifiedAt?: string;
  keywords?: string[];
  requiredSecrets?: string[];
  requiredTools?: string[];
  metadata?: SkillMetadata;
}

export interface SkillsCatalog {
  version: string;
  updated: string;
  categories: { curated: string[]; community: string[] };
  skills: { curated: SkillsCatalogEntry[]; community: SkillsCatalogEntry[] };
  stats?: Record<string, unknown>;
}

// ── Catalog JSON loader ─────────────────────────────────────────────────────

/**
 * Load the registry.json catalog from the `@framers/agentos-skills` content package.
 */
export async function getSkillsCatalog(): Promise<SkillsCatalog> {
  const registryPath = resolveCatalogPath();
  const raw = await fs.readFile(registryPath, 'utf-8');
  return JSON.parse(raw) as SkillsCatalog;
}

/**
 * Convenience: list curated skills from the catalog.
 */
export async function getAvailableCuratedSkills(): Promise<SkillsCatalogEntry[]> {
  const catalog = await getSkillsCatalog();
  return catalog.skills.curated ?? [];
}

// ── Factory functions (lazy-load @framers/agentos) ──────────────────────────

async function populateCuratedRegistry(args: {
  registry: InstanceType<Awaited<ReturnType<typeof requireAgentOS>>['SkillRegistry']>;
  runtime: Awaited<ReturnType<typeof requireAgentOS>>;
  selection: CuratedSkillsSelection;
}): Promise<void> {
  const names = getSkillEntries(args.selection).map((entry) => entry.name);
  const loadedSkills = await loadSkillsByNames(names);

  for (const loadedSkill of loadedSkills) {
    args.registry.register({
      skill: {
        name: loadedSkill.name,
        description: loadedSkill.description,
        content: loadedSkill.content,
      },
      frontmatter: loadedSkill.frontmatter,
      metadata: loadedSkill.metadata ?? args.runtime.extractMetadata?.(loadedSkill.frontmatter),
      sourcePath: path.dirname(loadedSkill.sourcePath),
      source: 'bundled',
    });
  }
}

/**
 * Create a SkillRegistry loaded with bundled curated skills.
 *
 * **Requires** `@framers/agentos` as a peer dependency.
 * Throws a descriptive error if the peer dep is missing.
 */
export async function createCuratedSkillRegistry(
  options?: Pick<CuratedSkillsOptions, 'config' | 'skills'>
): Promise<InstanceType<Awaited<ReturnType<typeof requireAgentOS>>['SkillRegistry']>> {
  const runtime = await requireAgentOS();
  const registry = new runtime.SkillRegistry(options?.config);
  const selection = options?.skills ?? 'all';

  if (selection !== 'none') {
    await populateCuratedRegistry({
      registry,
      runtime,
      selection,
    });
  }

  return registry;
}

/**
 * Build a SkillSnapshot from bundled curated skills.
 *
 * **Requires** `@framers/agentos` as a peer dependency.
 * Throws a descriptive error if the peer dep is missing.
 */
export async function createCuratedSkillSnapshot(
  options?: CuratedSkillsOptions
): Promise<SkillSnapshot> {
  const createdAt = new Date();
  const selection = options?.skills ?? 'all';

  if (selection === 'none') {
    return {
      prompt: '',
      skills: [],
      resolvedSkills: [],
      version: 1,
      createdAt,
    };
  }

  const registry = await createCuratedSkillRegistry({
    config: options?.config,
    skills: selection,
  });

  return registry.buildSnapshot({
    platform: options?.platform,
    eligibility: options?.eligibility,
  });
}
