// @ts-nocheck
/**
 * @fileoverview Cross-Agent Skill Discovery (Feature 3.5)
 *
 * Discovers SKILL.md files from a workspace `.agents/skills/` directory,
 * parses their YAML frontmatter, and returns them as SkillCatalogEntry[]
 * compatible with the existing registry catalog.
 *
 * Workspace skills take priority over registry skills when names collide.
 *
 * A workspace skill is read only from a real folder directly below the skills
 * directory and a SKILL.md in that folder that is a regular file. A symbolic
 * link at either place, or a SKILL.md that is not a regular file, is skipped
 * with a warning and never read, and the loader each discovered skill carries
 * reads its SKILL.md the same way.
 *
 * @module @framers/agentos-skills-registry/workspace-discovery
 */

import fs from 'node:fs/promises';
import { constants as fsConstants, type BigIntStats } from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';
import {
  loadSkillFromContent,
  type LoadedSkill,
  type LoadedSkillFrontmatter,
  type SkillCatalogEntry,
} from './catalog.js';

// ── Frontmatter types ───────────────────────────────────────────────────────

/** Raw frontmatter fields extracted from a workspace SKILL.md */
export interface SkillFrontmatter extends LoadedSkillFrontmatter {
  name: string;
  version?: string;
  description?: string;
  category?: string;
  tags?: string[];
  author?: string;
  namespace?: string;
  requires_secrets?: string[];
  requires_tools?: string[];
  metadata?: Record<string, unknown>;
}

/** Options for workspace skill discovery */
export interface WorkspaceDiscoveryOptions {
  /**
   * Absolute or relative path to the workspace skills directory.
   * Defaults to `.agents/skills/` resolved from `cwd`.
   */
  skillsDir?: string;

  /**
   * Working directory used to resolve relative `skillsDir`.
   * Defaults to `process.cwd()`.
   */
  cwd?: string;
}

// ── Frontmatter parser ──────────────────────────────────────────────────────

/**
 * YAML frontmatter parser for workspace SKILL.md files.
 */
export function parseSkillFrontmatter(content: string): SkillFrontmatter | null {
  // Extract frontmatter block between leading --- fences
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const block = match[1];
  let parsed: unknown;
  try {
    parsed = YAML.parse(block);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const result = parsed as SkillFrontmatter;

  // name is required
  if (typeof result.name !== 'string' || !result.name) return null;

  return {
    name: result.name as string,
    version: (result.version as string) ?? undefined,
    description: (result.description as string) ?? undefined,
    category: (result.category as string) ?? undefined,
    tags: Array.isArray(result.tags) ? (result.tags as string[]) : undefined,
    author: (result.author as string) ?? undefined,
    namespace: (result.namespace as string) ?? undefined,
    requires_secrets: Array.isArray(result.requires_secrets)
      ? (result.requires_secrets as string[])
      : undefined,
    requires_tools: Array.isArray(result.requires_tools)
      ? (result.requires_tools as string[])
      : undefined,
    metadata: (result.metadata as Record<string, unknown>) ?? undefined,
  };
}

// ── Reading a skill's file without following links ──────────────────────────

/**
 * The flags a SKILL.md is opened with: read only, never through a symbolic link
 * in the file's own place (`O_NOFOLLOW`) and never waiting (`O_NONBLOCK`), where
 * the platform has each flag; Windows has neither. Without `O_NONBLOCK`, opening
 * a named pipe that no process writes waits for a writer that may never come.
 */
const READ_FLAGS: number =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

/** The codes an open with `O_NOFOLLOW` fails with when a symbolic link holds the file's place (EMLINK on FreeBSD). */
const LINK_OPEN_CODES: ReadonlySet<string> = new Set(['ELOOP', 'EMLINK']);

/**
 * The codes an open fails with when something other than a regular file holds
 * the file's place: EISDIR for a folder, ENXIO for a device with no driver or,
 * on Linux, a socket, and EOPNOTSUPP for a socket on macOS.
 */
const SPECIAL_OPEN_CODES: ReadonlySet<string> = new Set(['EISDIR', 'ENXIO', 'EOPNOTSUPP']);

/** Why a workspace skill's SKILL.md was not read. */
type Refusal = 'linked-folder' | 'linked-file' | 'not-a-file' | 'replaced';

/** The words a warning or an error gives for each refusal. */
const REFUSAL_REASONS: Readonly<Record<Refusal, string>> = {
  'linked-folder': 'the skill folder is a symbolic link',
  'linked-file': 'its SKILL.md is a symbolic link',
  'not-a-file': 'its SKILL.md is not a regular file',
  replaced: 'its SKILL.md was replaced while it was being opened',
};

/**
 * Read `<skillsDir>/<folderName>/SKILL.md` without following a symbolic link
 * below `skillsDir`. The skill folder and its SKILL.md are each looked at with
 * lstat before the open: a link at either place is refused, and so is a
 * SKILL.md that is not a regular file (a folder, a named pipe, a socket, a
 * device). The file is then opened never through a link in its own place and
 * never waiting, where the platform has the flags, and it is read only when the
 * open file is a regular file with the device and inode numbers the look saw.
 * `skillsDir` itself is the caller's choice and may be a link.
 *
 * Node has no `openat`, so a skill folder that another process swaps for a link
 * between its look and the open is outside what these checks stop.
 *
 * @param skillsDir  - Absolute path of the skills folder.
 * @param folderName - The skill folder's name, as `readdir` lists it.
 * @returns The file's text; null when `folderName` is not a folder or holds no
 *   SKILL.md; or the refusal.
 * @throws Any other error the looks, the open or the read meet.
 */
async function readSkillFileOutsideLinks(
  skillsDir: string,
  folderName: string,
): Promise<{ text: string } | Refusal | null> {
  const folder = path.join(skillsDir, folderName);
  const folderEntry = await lstatOrNull(folder);
  if (folderEntry === null) return null;
  if (folderEntry.isSymbolicLink()) return 'linked-folder';
  // A file beside the skill folders is not a skill.
  if (!folderEntry.isDirectory()) return null;

  const file = path.join(folder, 'SKILL.md');
  const fileEntry = await lstatOrNull(file);
  if (fileEntry === null) return null;
  if (fileEntry.isSymbolicLink()) return 'linked-file';
  if (!fileEntry.isFile()) return 'not-a-file';

  const handle = await fs.open(file, READ_FLAGS).catch((err: unknown) => {
    const code = String((err as NodeJS.ErrnoException).code);
    // Taken away since the look.
    if (code === 'ENOENT') return null;
    if (LINK_OPEN_CODES.has(code)) return 'linked-file' as const;
    if (SPECIAL_OPEN_CODES.has(code)) return 'not-a-file' as const;
    throw err;
  });
  if (handle === null || typeof handle === 'string') return handle;
  try {
    const opened = await handle.stat({ bigint: true });
    // Something put in the file's place since the look is refused here, before it is read.
    if (!opened.isFile()) return 'not-a-file';
    if (!sameFile(fileEntry, opened)) return 'replaced';
    return { text: await handle.readFile({ encoding: 'utf8' }) };
  } finally {
    await handle.close();
  }
}

/**
 * True when the look and the open reached one file: the same device and inode
 * numbers, or a file system that reports an inode of 0, which names no file.
 */
function sameFile(looked: BigIntStats, opened: BigIntStats): boolean {
  if (looked.ino === 0n || opened.ino === 0n) return true;
  return looked.dev === opened.dev && looked.ino === opened.ino;
}

/** The entry at `place` itself, a link not followed, or null when there is none. */
async function lstatOrNull(place: string): Promise<BigIntStats | null> {
  try {
    return await fs.lstat(place, { bigint: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOTDIR: a folder on the way became a file since it was listed.
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
}

/** The error's code when it has one, such as EACCES, and its message otherwise. */
function errorReason(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && code) return code;
  return err instanceof Error ? err.message : String(err);
}

/** Write the one warning line for a workspace skill that discovery skipped. */
function warnSkipped(folder: string, reason: string): void {
  console.warn(`[agentos-skills-registry] Skipped the workspace skill at ${folder}: ${reason}.`);
}

// ── Skill discovery ─────────────────────────────────────────────────────────

/**
 * Create the lazy loader of a workspace skill. Each call reads the skill's
 * SKILL.md again, the way discovery read it: never through a symbolic link
 * below the skills folder, and only when it is a regular file. A refused or
 * missing file rejects the call.
 */
function createWorkspaceSkillLoader(
  skillsDir: string,
  folderName: string,
  displayName: string,
): () => Promise<LoadedSkill> {
  const absolutePath = path.join(skillsDir, folderName, 'SKILL.md');
  return async () => {
    let read: { text: string } | Refusal | null;
    try {
      read = await readSkillFileOutsideLinks(skillsDir, folderName);
    } catch (err) {
      throw new Error(
        `Failed to load SKILL.md at ${absolutePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (read === null) {
      throw new Error(`Failed to load SKILL.md at ${absolutePath}: the file is not there`);
    }
    if (typeof read === 'string') {
      throw new Error(`Failed to load SKILL.md at ${absolutePath}: ${REFUSAL_REASONS[read]}`);
    }
    return loadSkillFromContent({ absolutePath, content: read.text, displayName });
  };
}

/**
 * Convert parsed frontmatter + filesystem path into a SkillCatalogEntry.
 */
function frontmatterToEntry(
  fm: SkillFrontmatter,
  skillPath: string,
  skillsDir: string,
  folderName: string,
): SkillCatalogEntry {
  const displayName = fm.name
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return {
    name: fm.name,
    displayName,
    description: fm.description ?? '',
    category: fm.category ?? 'workspace',
    tags: fm.tags ?? [],
    requiredSecrets: fm.requires_secrets ?? [],
    requiredTools: fm.requires_tools ?? [],
    skillPath,
    source: 'community' as const,
    namespace: 'wunderland',
    available: true,
    loadSkill: createWorkspaceSkillLoader(skillsDir, folderName, displayName),
  };
}

/**
 * Discover SKILL.md files from a workspace directory.
 *
 * Scans `<skillsDir>/` for sub-directories containing a SKILL.md file,
 * parses the YAML frontmatter, and returns the discovered skills as
 * SkillCatalogEntry[] compatible with the existing catalog.
 *
 * If the directory does not exist, returns an empty array.
 *
 * Symbolic links below `<skillsDir>/` are not followed. A skill folder that is
 * a link, a SKILL.md that is a link, and a SKILL.md that is not a regular file
 * are each skipped with one warning line, and nothing is read through them.
 * Each entry's `loadSkill()` reads its SKILL.md the same way, so it rejects
 * once the skill folder or the file has become a link. `<skillsDir>` itself is
 * the caller's choice and may be a link.
 *
 * @example
 * ```ts
 * import { discoverWorkspaceSkills } from '@framers/agentos-skills-registry';
 *
 * // Uses default .agents/skills/ in cwd
 * const skills = await discoverWorkspaceSkills();
 *
 * // Custom path
 * const skills2 = await discoverWorkspaceSkills({
 *   skillsDir: '/my/project/.agents/skills',
 * });
 * ```
 */
export async function discoverWorkspaceSkills(
  options?: WorkspaceDiscoveryOptions,
): Promise<SkillCatalogEntry[]> {
  const cwd = options?.cwd ?? process.cwd();
  const skillsDir = options?.skillsDir
    ? path.resolve(cwd, options.skillsDir)
    : path.resolve(cwd, '.agents', 'skills');

  // If directory doesn't exist, return empty array
  let entries: string[];
  try {
    entries = await fs.readdir(skillsDir);
  } catch {
    return [];
  }

  const discovered: SkillCatalogEntry[] = [];

  for (const entry of entries) {
    const entryPath = path.join(skillsDir, entry);

    // Only real directories, and a SKILL.md in one that is a regular file
    let read: { text: string } | Refusal | null;
    try {
      read = await readSkillFileOutsideLinks(skillsDir, entry);
    } catch (err) {
      warnSkipped(entryPath, `its SKILL.md could not be read (${errorReason(err)})`);
      continue;
    }
    if (read === null) continue;
    if (typeof read === 'string') {
      warnSkipped(entryPath, REFUSAL_REASONS[read]);
      continue;
    }

    const frontmatter = parseSkillFrontmatter(read.text);
    if (!frontmatter) continue;

    // Use relative path from skillsDir for the skillPath
    const skillMdPath = path.join(entryPath, 'SKILL.md');
    const relativePath = path.relative(skillsDir, skillMdPath);
    discovered.push(frontmatterToEntry(frontmatter, relativePath, skillsDir, entry));
  }

  return discovered;
}

/**
 * Merge workspace-discovered skills with the registry catalog.
 *
 * Workspace skills take priority: if a workspace skill has the same `name`
 * as a registry skill, the workspace version replaces the registry one.
 *
 * @param registrySkills  - Skills from the built-in catalog (SKILLS_CATALOG)
 * @param workspaceSkills - Skills discovered from the workspace directory
 * @returns Merged array with workspace overrides applied
 */
export function mergeWithWorkspaceSkills(
  registrySkills: SkillCatalogEntry[],
  workspaceSkills: SkillCatalogEntry[],
): SkillCatalogEntry[] {
  if (workspaceSkills.length === 0) return registrySkills;

  const workspaceNames = new Set(workspaceSkills.map((s) => s.name));

  // Filter out registry skills that are overridden by workspace skills
  const filtered = registrySkills.filter((s) => !workspaceNames.has(s.name));

  // Workspace skills come first (higher priority), then remaining registry skills
  return [...workspaceSkills, ...filtered];
}
