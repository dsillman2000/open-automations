import { DBOS } from '@dbos-inc/dbos-sdk';
import { generateText } from 'ai';
import { createOpencode } from 'ai-sdk-provider-opencode-sdk';
import { z } from 'zod';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DRAFT_TABLE = 'changelog_draft';

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

let _opencode: ReturnType<typeof createOpencode>;

function getOpencode() {
  if (!_opencode) {
    const password = process.env.OPENCODE_SERVER_PASSWORD;
    const auth = password
      ? { Authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64') }
      : undefined;
    _opencode = createOpencode({
      autoStartServer: true,
      serverTimeout: 30000,
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

export interface DraftData {
  entry: string;
  insertBeforeAnchor: string;
  targetPath: string;
}

const ChangelogEntrySchema = z.object({
  hasChanges: z.boolean(),
  entry: z.string(),
  insertBeforeAnchor: z.string(),
  placementDescription: z.string(),
});

async function queryDB(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
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
      CREATE TABLE IF NOT EXISTS dbos.${DRAFT_TABLE} (
        id INT PRIMARY KEY DEFAULT 1,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT single_row CHECK (id = 1)
      )
    `);
    const result = await pool.query(sql, params);
    return result.rows;
  } finally {
    await pool.end();
  }
}

export class ChangelogAutomation {

  @DBOS.step()
  static async getGitCommits(from: string, to: string): Promise<string> {
    try {
      const range = `${from}..${to}`;
      const command = `git log ${range} --oneline --pretty=format:"%h - %an: %s"`;
      const cwd = process.env.OPEN_AUTOMATE_CWD || process.cwd();
      return execSync(command, { encoding: 'utf8', cwd });
    } catch (error) {
      throw new Error(`Failed to extract git context: ${(error as Error).message}`);
    }
  }

  @DBOS.step()
  static async readExistingChangelog(filePath: string): Promise<string> {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
  }

  @DBOS.step()
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

  @DBOS.workflow()
  static async runWorkflow(args: ChangelogArgs) {
    const userCwd = process.env.OPEN_AUTOMATE_CWD || process.cwd();
    const targetPath = args.changelogPath
      ? path.resolve(args.changelogPath)
      : path.join(userCwd, 'CHANGELOG.md');
    const to = args.to || 'HEAD';

    console.log(`Generating changelog entry from ${args.from}..${to} ...`);
    const rawCommits = await ChangelogAutomation.getGitCommits(args.from, to);
    const existingContent = await ChangelogAutomation.readExistingChangelog(targetPath);

    if (!rawCommits.trim()) {
      console.log('No commits found in range.');
      return;
    }

    const analysis = await ChangelogAutomation.generateChangelogEntry(rawCommits, existingContent, args.from, to);

    if (!analysis.hasChanges) {
      console.log('No new changes to add to changelog.');
      return;
    }

    console.log('\n--- Proposed Changelog Entry ---\n');
    console.log(analysis.entry.trim());
    console.log('\n--- Placement ---');
    console.log(analysis.placementDescription);
    console.log('\n---');
    console.log('Run with --approve to apply or --reject to discard.\n');

    await queryDB(
      `INSERT INTO dbos.${DRAFT_TABLE} (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = $1, created_at = NOW()`,
      [JSON.stringify({ entry: analysis.entry, insertBeforeAnchor: analysis.insertBeforeAnchor, targetPath } satisfies DraftData)],
    );
  }

  static async applyEntry(targetPath: string, entry: string, insertBeforeAnchor: string) {
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

  static async getDraft(): Promise<DraftData | null> {
    const rows = await queryDB(`SELECT data FROM dbos.${DRAFT_TABLE} WHERE id = 1`);
    return rows.length > 0 ? (rows[0].data as DraftData) : null;
  }

  static async clearDraft() {
    await queryDB(`DELETE FROM dbos.${DRAFT_TABLE} WHERE id = 1`);
  }
}
