import { Command } from 'commander';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { ChangelogAutomation, reserveId, insertWorkflow, updateWorkflow, getWorkflow, listWorkflows } from './automations/changelog';

function resolveId(input: string): string {
  if (input.startsWith('changelog/')) return input;
  const parts = input.split('/');
  if (parts.length === 2) {
    return `changelog/${parts[0]}/${parts[1]}`;
  }
  const cwd = process.env.OPEN_AUTOMATE_CWD || process.cwd();
  const projectName = path.basename(cwd);
  return `changelog/${projectName}/${parts[0]}`;
}

function getProjectName(): string {
  const cwd = process.env.OPEN_AUTOMATE_CWD || process.cwd();
  return path.basename(cwd);
}

const program = new Command();

program
  .name('open-automate')
  .description('Open Automations CLI');

program
  .command('setup')
  .description('Start required services (Postgres + opencode serve)')
  .action(async () => {
    const { execSync } = await import('child_process');

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
  .command('run')
  .description('Generate a changelog entry for a commit range')
  .requiredOption('--from <ref>', 'start point for comparison (tag, commit hash, etc.)')
  .option('--to <ref>', 'end point for comparison (defaults to HEAD)')
  .action(async (opts: { from: string; to?: string }) => {
    const projectName = getProjectName();
    const workflowId = await reserveId(projectName);
    const to = opts.to || 'HEAD';

    await insertWorkflow(workflowId, 'working', { step: 'spawned' });

    const workerEnv = {
      ...process.env,
      WORKER_ID: workflowId,
      WORKER_FROM: opts.from,
      WORKER_TO: to,
      WORKER_CWD: process.env.OPEN_AUTOMATE_CWD || process.cwd(),
    };

    const worker = spawn(
      process.argv[0],
      ['node_modules/.bin/tsx', 'src/automations/changelog/worker.ts'],
      {
        stdio: 'ignore',
        detached: true,
        env: workerEnv,
      },
    );
    worker.unref();

    console.log(`${workflowId} spawned.`);
    console.log(`Run \`open-automate changelog status ${workflowId}\` to check progress.`);
  });

changelog
  .command('status <id>')
  .description('Show the current status and entry for a changelog workflow')
  .action(async (inputId: string) => {
    const wf = await getWorkflow(resolveId(inputId));
    if (!wf) {
      console.error(`Workflow '${resolveId(inputId)}' not found.`);
      process.exit(1);
    }

    console.log(`ID:       ${wf.workflow_id}`);
    console.log(`Status:   ${wf.status}`);
    console.log(`Created:  ${new Date(wf.created_at).toLocaleString()}`);
    if (wf.step_info) {
      const info = typeof wf.step_info === 'string' ? JSON.parse(wf.step_info) : wf.step_info;
      if (info.step) console.log(`Step:     ${info.step}`);
      if (info.error) console.log(`Error:    ${info.error}`);
    }

    if (wf.entry) {
      console.log('\n--- Proposed Entry ---\n');
      console.log(wf.entry.trim());
      console.log('\n---');
      if (wf.placement_description) console.log(`\nPlacement: ${wf.placement_description}`);
    }

    if (wf.status === 'pending') {
      console.log(`\nRun \`open-automate changelog accept ${wf.workflow_id}\` to apply or \`open-automate changelog reject ${wf.workflow_id}\` to discard.`);
    }
  });

changelog
  .command('accept <id>')
  .description('Accept and apply a pending changelog entry')
  .action(async (inputId: string) => {
    const workflowId = resolveId(inputId);
    const wf = await getWorkflow(workflowId);
    if (!wf) {
      console.error(`Workflow '${workflowId}' not found.`);
      process.exit(1);
    }
    if (wf.status !== 'pending' || !wf.entry || !wf.target_path) {
      console.error(`Workflow '${workflowId}' is not in a pending state with a draft.`);
      process.exit(1);
    }
    ChangelogAutomation.applyEntry(wf.target_path, wf.entry, wf.insert_before_anchor || '');
    await updateWorkflow(workflowId, { status: 'accepted' });
    console.log(`Changelog entry applied to ${wf.target_path}`);
  });

changelog
  .command('reject <id>')
  .description('Reject and discard a pending changelog entry')
  .action(async (inputId: string) => {
    const workflowId = resolveId(inputId);
    const wf = await getWorkflow(workflowId);
    if (!wf) {
      console.error(`Workflow '${workflowId}' not found.`);
      process.exit(1);
    }
    if (wf.status !== 'pending') {
      console.error(`Workflow '${workflowId}' is not pending.`);
      process.exit(1);
    }
    await updateWorkflow(workflowId, { status: 'rejected' });
    console.log(`Changelog entry rejected.`);
  });

const workflows = program
  .command('workflows')
  .description('Introspect automation workflows');

workflows
  .command('list')
  .description('List recent automation workflows')
  .option('-n, --limit <count>', 'max workflows to show', '10')
  .action(async (opts: { limit: string }) => {
    const limit = Math.min(parseInt(opts.limit, 10) || 10, 50);
    const rows = await listWorkflows(limit);
    if (rows.length === 0) {
      console.log('No workflows found.');
      return;
    }
    for (const wf of rows) {
      const step = wf.step_info && typeof wf.step_info === 'object' && 'step' in wf.step_info
        ? (wf.step_info as Record<string, unknown>).step as string
        : '';
      const time = new Date(wf.created_at).toLocaleString();
      console.log(`${String(wf.status).padEnd(12)} ${String(wf.workflow_id).padEnd(40)} ${String(step).padEnd(14)} ${time}`);
    }
  });

workflows
  .command('get <id>')
  .description('Show full details for a specific workflow')
  .action(async (inputId: string) => {
    const workflowId = resolveId(inputId);
    const wf = await getWorkflow(workflowId);
    if (!wf) {
      console.error(`Workflow '${workflowId}' not found.`);
      process.exit(1);
    }

    console.log(`ID:           ${wf.workflow_id}`);
    console.log(`Status:       ${wf.status}`);
    console.log(`Created:      ${new Date(wf.created_at).toLocaleString()}`);
    console.log(`Updated:      ${new Date(wf.updated_at).toLocaleString()}`);

    if (wf.step_info) {
      const info = typeof wf.step_info === 'string' ? JSON.parse(wf.step_info) : wf.step_info;
      console.log(`Step:         ${info.step || '-'}`);
      if (info.error) console.log(`Error:        ${info.error}`);
    }

    if (wf.target_path) console.log(`Target:       ${wf.target_path}`);
    if (wf.placement_description) console.log(`Placement:    ${wf.placement_description}`);

    if (wf.entry) {
      console.log(`\nEntry:\n${wf.entry.trim()}\n`);
    }
  });

export { program };
