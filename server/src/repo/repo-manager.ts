import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

export interface RepoContext {
  mode: 'managed-remote';
  controlRepoPath: string;
  sourceDescription: string;
  remoteUrl: string;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function git(args: string[], cwd?: string): Promise<string> {
  const cmdString = `git ${args.join(' ')}`;
  console.log(`[repo-manager] Running: ${cmdString}${cwd ? ` (cwd: ${cwd})` : ''}`);

  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      ...(cwd ? { cwd } : {}),
      encoding: 'utf-8',
    });
    if (stderr?.trim()) {
      console.log(`[repo-manager] stderr: ${stderr.trim()}`);
    }
    return stdout.trim();
  } catch (error: any) {
    console.error(`[repo-manager] Command failed: ${cmdString}`);
    console.error(`[repo-manager] stderr: ${error.stderr?.trim()}`);
    throw error;
  }
}

async function ensureRemoteOrigin(controlRepoPath: string, remoteUrl: string): Promise<void> {
  try {
    const current = await git(['remote', 'get-url', 'origin'], controlRepoPath);
    if (current !== remoteUrl) {
      await git(['remote', 'set-url', 'origin', remoteUrl], controlRepoPath);
    }
  } catch {
    await git(['remote', 'add', 'origin', remoteUrl], controlRepoPath);
  }
}

async function ensureManagedRemoteRepo(fetchLatest: boolean): Promise<RepoContext> {
  const controlRepoPath = config.repoControlDir;
  const remoteUrl = config.targetRepoUrl;
  const gitDir = path.join(controlRepoPath, '.git');

  await fs.mkdir(path.dirname(controlRepoPath), { recursive: true });

  if (!(await pathExists(gitDir))) {
    if (await pathExists(controlRepoPath)) {
      const entries = await fs.readdir(controlRepoPath);
      if (entries.length > 0) {
        throw new Error(
          `Repo control directory exists but is not a git repo: ${controlRepoPath}`,
        );
      }
    }

    console.log(`[repo-manager] Cloning control repo from ${remoteUrl} -> ${controlRepoPath}`);
    await git(['clone', '--origin', 'origin', remoteUrl, controlRepoPath]);
  }

  await ensureRemoteOrigin(controlRepoPath, remoteUrl);

  if (fetchLatest) {
    await git(['fetch', 'origin', config.baseBranch, '--prune'], controlRepoPath);
  }

  return {
    mode: 'managed-remote',
    controlRepoPath,
    sourceDescription: remoteUrl,
    remoteUrl,
  };
}

export async function ensureControlRepo(fetchLatest: boolean = true): Promise<RepoContext> {
  return ensureManagedRemoteRepo(fetchLatest);
}

export async function getControlRepoPath(fetchLatest: boolean = true): Promise<string> {
  const context = await ensureControlRepo(fetchLatest);
  return context.controlRepoPath;
}
