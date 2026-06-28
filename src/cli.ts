import { Command } from 'commander';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { ChangelogAutomation } from './automations/changelog';

const DAEMON_PID = '/tmp/open-automations-daemon.pid';

async function withDBOS<T>(fn: () => Promise<T>): Promise<T> {
  await DBOS.launch();
  try {
    return await fn();
  } finally {
    await DBOS.shutdown();
    process.exit(0);
  }
}

const program = new Command();

program
  .name('open-automate')
  .description('Open Automations CLI');

program
  .command('setup')
  .description('Start required services (Postgres + opencode serve)')
  .action(async () => {
    const { execSync, spawn } = await import('child_process');

    console.log('Starting Postgres...');
    execSync('bash scripts/init-postgres.sh', { stdio: 'inherit' });

    console.log('Starting opencode server...');
    const opencode = spawn('opencode', ['serve', '--port=4096'], {
      stdio: 'ignore',
      detached: true,
    });
    opencode.unref();

    console.log('Setup complete. Postgres and opencode serve are running.');
  });

const changelog = program
  .command('changelog')
  .description('Generate and manage changelog entries');

changelog
  .command('generate')
  .description('Generate a changelog entry for a commit range')
  .requiredOption('--from <ref>', 'start point for comparison (tag, commit hash, etc.)')
  .option('--to <ref>', 'end point for comparison (defaults to HEAD)')
  .action(async (opts: { from: string; to?: string }) => {
    const to = opts.to || 'HEAD';
    await withDBOS(() => ChangelogAutomation.runWorkflow({ from: opts.from, to }));
  });

changelog
  .command('approve')
  .description('Approve the pending changelog draft')
  .action(async () => {
    const draft = await ChangelogAutomation.getDraft();
    if (!draft) {
      console.error('No pending changelog draft found.');
      process.exit(1);
    }
    await ChangelogAutomation.applyEntry(draft.targetPath, draft.entry, draft.insertBeforeAnchor);
    await ChangelogAutomation.clearDraft();
    console.log('Changelog entry applied successfully!');
  });

changelog
  .command('reject')
  .description('Reject and discard the pending changelog draft')
  .action(async () => {
    const draft = await ChangelogAutomation.getDraft();
    if (!draft) {
      console.error('No pending changelog draft found.');
      process.exit(1);
    }
    await ChangelogAutomation.clearDraft();
    console.log('Changelog draft rejected. No changes made.');
  });

export { program };
