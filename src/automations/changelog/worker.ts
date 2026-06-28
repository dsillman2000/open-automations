import 'dotenv/config';
import * as path from 'path';
import { ChangelogAutomation, getWorkflow, updateWorkflow } from './index.js';

const workflowId = process.env.WORKER_ID!;

if (!workflowId) {
  console.error('Usage: WORKER_ID=<id> tsx worker.ts');
  process.exit(1);
}

async function main() {
  const row = await getWorkflow(workflowId);
  if (!row) {
    console.error(`Workflow '${workflowId}' not found.`);
    process.exit(1);
  }

  const isRevision = !!(row.step_info as Record<string, unknown>)?.feedback;
  const feedback = isRevision ? (row.step_info as Record<string, unknown>).feedback as string : undefined;
  const from = isRevision ? (row.args as Record<string, unknown>)?.from as string : process.env.WORKER_FROM!;
  const to = isRevision ? (row.args as Record<string, unknown>)?.to as string || 'HEAD' : process.env.WORKER_TO || 'HEAD';
  const userCwd = process.env.WORKER_CWD || process.env.OPEN_AUTOMATE_CWD || process.cwd();

  if (!from) {
    console.error('Missing from ref. Pass WORKER_FROM env or ensure args.from is stored.');
    process.exit(1);
  }

  await updateWorkflow(workflowId, {
    status: 'working',
    step_info: { step: 'generating', ...(feedback ? { feedback } : {}) },
  });

  const targetPath = path.join(userCwd, 'CHANGELOG.md');
  const existingContent = ChangelogAutomation.readExistingChangelog(targetPath);

  const rawCommits = ChangelogAutomation.getGitCommits(from, to);
  if (!rawCommits.trim()) {
    await updateWorkflow(workflowId, {
      status: 'error',
      step_info: { step: 'done', error: 'No commits found in range.' },
    });
    return;
  }

  const analysis = await ChangelogAutomation.generateChangelogEntry(
    rawCommits, existingContent, from, to,
    feedback && row.entry ? { previousEntry: row.entry, feedback } : undefined,
  );

  if (!analysis.hasChanges && !feedback) {
    await updateWorkflow(workflowId, {
      status: 'error',
      step_info: { step: 'done', error: 'No new changes to add to changelog.' },
    });
    return;
  }

  await updateWorkflow(workflowId, {
    status: 'pending',
    entry: analysis.entry,
    insert_before_anchor: analysis.insertBeforeAnchor,
    target_path: targetPath,
    placement_description: analysis.placementDescription,
    args: { from, to },
    step_info: { step: 'done' },
  });
}

main().catch(async (err) => {
  console.error('Worker failed:', err);
  try {
    await updateWorkflow(workflowId!, {
      status: 'error',
      step_info: { step: 'done', error: (err as Error).message },
    });
  } catch { }
  process.exit(1);
});
