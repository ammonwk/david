import os from 'os';
import path from 'path';

process.env.NODE_ENV ??= 'test';
process.env.TARGET_REPO_URL ??= 'https://example.com/test/repo.git';
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/david-test';
process.env.REPO_CONTROL_DIR ??= path.join(os.tmpdir(), 'david-test-control');
process.env.WORKTREES_DIR ??= path.join(os.tmpdir(), 'david-test-worktrees');
process.env.BASE_BRANCH ??= 'staging';
process.env.CLI_BACKEND ??= 'codex';
