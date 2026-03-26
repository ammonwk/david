import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export async function runGit(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf-8',
  });
  return stdout.trim();
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function seedRemoteRepo(rootDir: string): Promise<{
  bareRepoPath: string;
  seedRepoPath: string;
}> {
  const bareRepoPath = path.join(rootDir, 'remote.git');
  const seedRepoPath = path.join(rootDir, 'seed');

  await runGit(['init', '--bare', bareRepoPath]);
  await fs.mkdir(seedRepoPath, { recursive: true });
  await runGit(['init', '-b', 'staging'], seedRepoPath);
  await runGit(['config', 'user.name', 'David Test'], seedRepoPath);
  await runGit(['config', 'user.email', 'david@example.com'], seedRepoPath);
  await fs.writeFile(path.join(seedRepoPath, 'README.md'), '# seeded repo\n');
  await runGit(['add', 'README.md'], seedRepoPath);
  await runGit(['commit', '-m', 'seed repo'], seedRepoPath);
  await runGit(['remote', 'add', 'origin', bareRepoPath], seedRepoPath);
  await runGit(['push', '-u', 'origin', 'staging'], seedRepoPath);
  await runGit(['symbolic-ref', 'HEAD', 'refs/heads/staging'], bareRepoPath);

  return {
    bareRepoPath,
    seedRepoPath,
  };
}
