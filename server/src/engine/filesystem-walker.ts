import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileInfo {
  relativePath: string; // Relative to repo root
  absolutePath: string;
  lines: number;
  sizeBytes: number;
  extension: string;
}

export interface DirectoryTree {
  name: string;
  path: string; // Relative path
  type: 'file' | 'directory';
  children?: DirectoryTree[];
  lines?: number; // Only for files
  extension?: string; // Only for files
}

export interface WalkResult {
  files: FileInfo[];
  tree: DirectoryTree;
  totalFiles: number;
  totalLines: number;
  totalSizeBytes: number;
  byExtension: Record<string, { count: number; lines: number }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE_BYTES = 1_000_000; // 1 MB

/** Directories that are always skipped during traversal. */
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  'tmp',
  '__tests__',
  'tests',
  '.next',
  'scripts',
  'worktrees',
  'lambda-build',
  'five9_recordings',
  'videos',
  'churn-model',
  '.turbo',
  '.cache',
  '.parcel-cache',
]);

/** Only files with these extensions are collected. */
const INCLUDED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.sql',
  '.graphql',
  '.gql',
  '.json',
  '.yaml',
  '.yml',
  '.env.example',
  '.sh',
]);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Count the number of newline-delimited lines in `content`.
 * An empty string is 0 lines; a trailing newline does not add an extra line.
 */
function countLines(content: string): number {
  if (content.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) count++;
  }
  // If the file ends with a newline, don't count the empty trailing "line"
  if (content.charCodeAt(content.length - 1) === 10) count--;
  return count;
}

/**
 * Return the extension portion of a filename that should be matched against
 * INCLUDED_EXTENSIONS.  Handles compound extensions like `.env.example`.
 */
function getExtension(filename: string): string {
  // Check compound extensions first
  for (const ext of INCLUDED_EXTENSIONS) {
    if (ext.includes('.') && ext.startsWith('.') && filename.endsWith(ext)) {
      return ext;
    }
  }
  return path.extname(filename).toLowerCase();
}

/**
 * Recursively walk a directory, collecting both a flat file list and a nested
 * directory tree in a single pass.
 */
async function walkDirectory(
  dirAbsolute: string,
  repoRoot: string,
  files: FileInfo[],
): Promise<DirectoryTree> {
  const dirRelative = path.relative(repoRoot, dirAbsolute) || '.';
  const dirName = path.basename(dirAbsolute);

  const tree: DirectoryTree = {
    name: dirName,
    path: dirRelative,
    type: 'directory',
    children: [],
  };

  let entries;
  try {
    entries = await fs.readdir(dirAbsolute, { withFileTypes: true });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      console.warn(`[filesystem-walker] permission denied, skipping: ${dirAbsolute}`);
      return tree;
    }
    throw err;
  }

  // Sort entries for deterministic output
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const entryAbsolute = path.join(dirAbsolute, entry.name);

    // Skip symlinks
    if (entry.isSymbolicLink()) continue;

    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      const subtree = await walkDirectory(entryAbsolute, repoRoot, files);
      tree.children!.push(subtree);
      continue;
    }

    if (!entry.isFile()) continue;

    const ext = getExtension(entry.name);
    if (!INCLUDED_EXTENSIONS.has(ext)) continue;

    // Stat the file — skip on errors or if too large
    let stat;
    try {
      stat = await fs.stat(entryAbsolute);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        console.warn(`[filesystem-walker] permission denied, skipping: ${entryAbsolute}`);
        continue;
      }
      throw err;
    }

    if (stat.size > MAX_FILE_SIZE_BYTES) continue;

    // Read file contents to count lines
    let content: string;
    try {
      content = await fs.readFile(entryAbsolute, 'utf-8');
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        console.warn(`[filesystem-walker] permission denied reading: ${entryAbsolute}`);
        continue;
      }
      throw err;
    }

    const lines = countLines(content);
    const relativePath = path.relative(repoRoot, entryAbsolute);

    const fileInfo: FileInfo = {
      relativePath,
      absolutePath: entryAbsolute,
      lines,
      sizeBytes: stat.size,
      extension: ext,
    };

    files.push(fileInfo);

    tree.children!.push({
      name: entry.name,
      path: relativePath,
      type: 'file',
      lines,
      extension: ext,
    });
  }

  return tree;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Walk the repo and collect all source files.
 * Returns a flat file list, a nested directory tree, and aggregate statistics.
 */
export async function walkRepo(
  repoPath?: string,
): Promise<WalkResult> {
  const root = repoPath ?? config.targetRepoPath;
  const resolvedRoot = path.resolve(root);

  const files: FileInfo[] = [];
  const tree = await walkDirectory(resolvedRoot, resolvedRoot, files);

  // Compute aggregates
  let totalLines = 0;
  let totalSizeBytes = 0;
  const byExtension: Record<string, { count: number; lines: number }> = {};

  for (const file of files) {
    totalLines += file.lines;
    totalSizeBytes += file.sizeBytes;

    if (!byExtension[file.extension]) {
      byExtension[file.extension] = { count: 0, lines: 0 };
    }
    byExtension[file.extension].count++;
    byExtension[file.extension].lines += file.lines;
  }

  return {
    files,
    tree,
    totalFiles: files.length,
    totalLines,
    totalSizeBytes,
    byExtension,
  };
}

/**
 * Build a directory tree (for sending to LLMs).
 * Returns a clean tree structure without file contents.
 */
export async function buildDirectoryTree(
  repoPath?: string,
): Promise<DirectoryTree> {
  const result = await walkRepo(repoPath);
  return result.tree;
}

/**
 * Format the directory tree as a readable string (for LLM prompts).
 *
 * Produces output like:
 * ```
 * src/
 *   features/
 *     auth/
 *       login.ts (45 lines)
 *       signup.ts (120 lines)
 *     billing/
 *       ...
 * ```
 */
export function formatTreeForLLM(tree: DirectoryTree, indent: number = 0): string {
  const prefix = '  '.repeat(indent);
  const lines: string[] = [];

  if (tree.type === 'directory') {
    // Only show directory name with trailing slash (skip the root "." label)
    if (indent > 0 || tree.name !== '.') {
      lines.push(`${prefix}${tree.name}/`);
    }

    const childIndent = (indent > 0 || tree.name !== '.') ? indent + 1 : indent;

    if (tree.children) {
      // Directories first, then files — both alphabetically
      const dirs = tree.children.filter((c) => c.type === 'directory');
      const files = tree.children.filter((c) => c.type === 'file');

      for (const child of [...dirs, ...files]) {
        lines.push(formatTreeForLLM(child, childIndent));
      }
    }
  } else {
    const lineCount = tree.lines !== undefined ? ` (${tree.lines} lines)` : '';
    lines.push(`${prefix}${tree.name}${lineCount}`);
  }

  return lines.join('\n');
}

/**
 * Get FileInfo for a specific set of relative paths.
 * Useful for L2/L3 grouping where we already know which files to inspect.
 */
export async function getFilesForPaths(
  repoPath: string,
  relativePaths: string[],
): Promise<FileInfo[]> {
  const resolvedRoot = path.resolve(repoPath);
  const results: FileInfo[] = [];

  for (const relPath of relativePaths) {
    const absolutePath = path.join(resolvedRoot, relPath);

    let stat;
    try {
      stat = await fs.stat(absolutePath);
    } catch {
      // File doesn't exist or is inaccessible — skip silently
      continue;
    }

    if (!stat.isFile()) continue;
    if (stat.size > MAX_FILE_SIZE_BYTES) continue;

    let content: string;
    try {
      content = await fs.readFile(absolutePath, 'utf-8');
    } catch {
      continue;
    }

    const ext = getExtension(path.basename(absolutePath));
    const lines = countLines(content);

    results.push({
      relativePath: relPath,
      absolutePath,
      lines,
      sizeBytes: stat.size,
      extension: ext,
    });
  }

  return results;
}

/**
 * Read the first N lines of a file (for sending snippets to LLMs).
 */
export async function readFileHead(
  absolutePath: string,
  maxLines: number = 50,
): Promise<string> {
  let content: string;
  try {
    content = await fs.readFile(absolutePath, 'utf-8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return '';
    if (code === 'EACCES' || code === 'EPERM') {
      console.warn(`[filesystem-walker] permission denied reading: ${absolutePath}`);
      return '';
    }
    throw err;
  }

  const lines = content.split('\n');
  return lines.slice(0, maxLines).join('\n');
}
