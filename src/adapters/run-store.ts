import type { RunStorePort, RunTranscriptMessage } from "../application/execute-agent-run";

/** Minimal Cloudflare D1 surface used by the run store (avoids a types dep). */
type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
};
type D1Database = {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown>;
  exec(query: string): Promise<unknown>;
};

export type RunStoreBinding = D1Database | undefined;

/**
 * Persists agent-run transcripts to the customer's own Cloudflare D1 database.
 *
 * This is the data-residency boundary: in `executionMode: worker` the run
 * content (prompts, model messages, tool args/results) is written here, inside
 * the customer's account, and is NOT returned to the control plane. The control
 * plane keeps only run metadata, usage, and billing.
 *
 * If no D1 binding is configured the store reports unavailable and the Worker
 * falls back to returning the transcript to the control plane, so content is
 * never silently lost.
 */
export class WorkerRunStore implements RunStorePort {
  constructor(private readonly db: RunStoreBinding) {}

  isAvailable(): boolean {
    return this.db !== undefined;
  }

  async saveTranscript(input: {
    runId: string;
    deploymentId: string;
    messages: RunTranscriptMessage[];
    createdAtMs: number;
  }): Promise<void> {
    if (!this.db) {
      throw new Error("RUN_STORE D1 binding is required to persist run transcripts");
    }
    await this.db.exec(SCHEMA_SQL);

    const insert = this.db.prepare(
      "INSERT INTO run_messages (run_id, deployment_id, seq, role, tool_name, content, created_at)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const statements = input.messages.map((message, index) =>
      insert.bind(
        input.runId,
        input.deploymentId,
        index,
        message.role,
        message.toolName ?? null,
        message.content,
        input.createdAtMs,
      ),
    );
    if (statements.length > 0) {
      await this.db.batch(statements);
    }
  }
}

// D1's exec() runs one statement per line, so keep each statement on a single line.
const SCHEMA_SQL = [
  "CREATE TABLE IF NOT EXISTS run_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, deployment_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, tool_name TEXT, content TEXT NOT NULL, created_at INTEGER NOT NULL);",
  "CREATE INDEX IF NOT EXISTS idx_run_messages_run ON run_messages (run_id);",
].join("\n");
