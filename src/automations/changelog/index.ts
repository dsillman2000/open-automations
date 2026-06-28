import { generateText } from 'ai';
import { createOpencode } from 'ai-sdk-provider-opencode-sdk';
import { z } from 'zod';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let _opencode: ReturnType<typeof createOpencode>;

function getOpencode() {
  if (!_opencode) {
    const password = process.env.OPENCODE_SERVER_PASSWORD;
    const auth = password
      ? { Authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64') }
      : undefined;
    _opencode = createOpencode({
      autoStartServer: false,
      clientOptions: auth ? { headers: auth } : undefined,
    });
  }
  return _opencode;
}

export interface ChangelogArgs {
  from: string;
  to?: string;
  changelogPath?: string;
}

export interface WorkflowRow {
  workflow_id: string;
  status: string;
  entry: string | null;
  insert_before_anchor: string | null;
  target_path: string | null;
  placement_description: string | null;
  step_info: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

const ChangelogEntrySchema = z.object({
  hasChanges: z.boolean(),
  entry: z.string(),
  insertBeforeAnchor: z.string(),
  placementDescription: z.string(),
});

async function withPg<T>(fn: (pool: import('pg').Pool) => Promise<T>): Promise<T> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    user: 'open',
    password: 'automations',
    host: 'localhost',
    port: 5432,
    database: 'open_automations_dbos_sys',
  });
  try {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS dbos`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dbos.automation_sequences (
        project_name TEXT PRIMARY KEY,
        last_sequence INTEGER NOT NULL DEFAULT 0
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dbos.automation_workflows (
        workflow_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        entry TEXT,
        insert_before_anchor TEXT,
        target_path TEXT,
        placement_description TEXT,
        step_info JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

export async function reserveId(projectName: string): Promise<string> {
  return withPg(async (pool) => {
    const r = await pool.query(
      `INSERT INTO dbos.automation_sequences (project_name, last_sequence)
       VALUES ($1, 1)
       ON CONFLICT (project_name) DO UPDATE SET last_sequence = automation_sequences.last_sequence + 1
       RETURNING last_sequence`,
      [projectName],
    );
    const seq: number = r.rows[0].last_sequence;
    return `changelog/${projectName}/${seq}`;
  });
}

export async function insertWorkflow(
  workflowId: string,
  status: string,
  stepInfo: Record<string, unknown>,
) {
  return withPg(async (pool) => {
    await pool.query(
      `INSERT INTO dbos.automation_workflows (workflow_id, status, step_info)
       VALUES ($1, $2, $3)`,
      [workflowId, status, JSON.stringify(stepInfo)],
    );
  });
}

export async function updateWorkflow(
  workflowId: string,
  fields: Partial<Pick<WorkflowRow, 'status' | 'entry' | 'insert_before_anchor' | 'target_path' | 'placement_description' | 'step_info'>>,
) {
  const setClauses: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      setClauses.push(`${key} = $${idx++}`);
      params.push(key === 'step_info' ? JSON.stringify(value) : value);
    }
  }
  if (setClauses.length === 0) return;
  setClauses.push(`updated_at = NOW()`);
  params.push(workflowId);
  return withPg(async (pool) => {
    await pool.query(
      `UPDATE dbos.automation_workflows SET ${setClauses.join(', ')} WHERE workflow_id = $${idx}`,
      params,
    );
  });
}

export async function getWorkflow(workflowId: string): Promise<WorkflowRow | null> {
  return withPg(async (pool) => {
    const r = await pool.query(
      `SELECT * FROM dbos.automation_workflows WHERE workflow_id = $1`,
      [workflowId],
    );
    return r.rows.length > 0 ? r.rows[0] as WorkflowRow : null;
  });
}

export async function listWorkflows(limit: number): Promise<WorkflowRow[]> {
  return withPg(async (pool) => {
    const r = await pool.query(
      `SELECT * FROM dbos.automation_workflows ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return r.rows as WorkflowRow[];
  });
}

function readSpec(): string {
  const candidates = [
    path.join(__dirname, 'KEEP_A_CHANGELOG.md'),
    path.join(__dirname, '../../src/automations/changelog/KEEP_A_CHANGELOG.md'),
  ];
  for (const p of candidates) {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch { }
  }
  return '(spec not found)';
}

export class ChangelogAutomation {

  static getGitCommits(from: string, to: string): string {
    try {
      const range = `${from}..${to}`;
      const command = `git log ${range} --oneline --pretty=format:"%h - %an: %s"`;
      const cwd = process.env.OPEN_AUTOMATE_CWD || process.cwd();
      return execSync(command, { encoding: 'utf8', cwd });
    } catch (error) {
      throw new Error(`Failed to extract git context: ${(error as Error).message}`);
    }
  }

  static readExistingChangelog(filePath: string): string {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
  }

  static async generateChangelogEntry(
    commits: string,
    currentChangelog: string,
    from: string,
    to: string,
  ): Promise<z.infer<typeof ChangelogEntrySchema>> {
    const result = await generateText({
      model: getOpencode()('opencode/big-pickle'),
      prompt: `
        You are an expert release engineer generating a single changelog entry.
        Respond with a JSON object only, no markdown or other text.

        The new commits in range ${from}..${to} are:
        """
        ${commits}
        """

        The existing CHANGELOG.md content is:
        """
        ${currentChangelog || '(file does not exist yet)'}
        """

        TASK:
        1. Analyze the commits and categorize them using the six change types (Added, Changed, Deprecated, Removed, Fixed, Security).
        2. Generate a single markdown changelog entry for this release conforming exactly to the spec.
        3. Determine the best insertion point in the existing file:
           - If the file has an '## [Unreleased]' section, insert above it.
           - Otherwise, insert before the first existing release header (e.g., '## [1.0.0]').
           - If no file exists or the entry should go at the end, return an empty string for insertBeforeAnchor.
        4. Set hasChanges to false only if all commits are already fully represented in the existing changelog.

        Below is the "Keep a Changelog" specification that your output must conform to:
        ${readSpec()}

        Respond with valid JSON matching this schema:
        {
          "hasChanges": boolean,
          "entry": "the markdown entry",
          "insertBeforeAnchor": "anchor string or empty string",
          "placementDescription": "where it goes"
        }
      `,
    });
    const text = result.text.replace(/^```json\s*/m, '').replace(/\s*```$/m, '').trim();
    return JSON.parse(text);
  }

  static applyEntry(targetPath: string, entry: string, insertBeforeAnchor: string) {
    const formatted = '\n' + entry.trim() + '\n\n';
    let existing = '';
    if (fs.existsSync(targetPath)) {
      existing = fs.readFileSync(targetPath, 'utf8');
    }

    if (!existing.trim()) {
      fs.writeFileSync(targetPath, entry.trimStart() + '\n', 'utf8');
    } else if (insertBeforeAnchor) {
      const idx = existing.indexOf(insertBeforeAnchor);
      if (idx !== -1) {
        const before = existing.slice(0, idx);
        const after = existing.slice(idx);
        fs.writeFileSync(targetPath, before + formatted + after, 'utf8');
      } else {
        fs.writeFileSync(targetPath, existing.trimEnd() + '\n\n' + entry.trimStart() + '\n', 'utf8');
      }
    } else {
      fs.writeFileSync(targetPath, existing.trimEnd() + '\n\n' + entry.trimStart() + '\n', 'utf8');
    }
  }
}
