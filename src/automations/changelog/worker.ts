import 'dotenv/config';
import * as path from 'path';
import { ChangelogAutomation, updateWorkflow } from './index.js';

const workflowId = process.env.WORKER_ID!;
const from = process.env.WORKER_FROM!;
const to = process.env.WORKER_TO || 'HEAD';
const userCwd = process.env.WORKER_CWD || process.env.OPEN_AUTOMATE_CWD || process.cwd();

if (!workflowId || !from) {
  console.error('Usage: WORKER_ID=<id> WORKER_FROM=<ref> [WORKER_TO=<ref>] tsx worker.ts');
  process.exit(1);
}

async function main() {
  await updateWorkflow(workflowId, { status: 'working', step_info: { step: 'generating' } });

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

  const analysis = await ChangelogAutomation.generateChangelogEntry(rawCommits, existingContent, from, to);

  if (!analysis.hasChanges) {
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
