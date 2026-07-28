import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";
import type { AuthoritativeCanvasCommitPort } from "./authoritativeCanvasCommitPort.js";
import { ContentVersionRepository } from "./contentVersionRepository.js";
import { CanvasCommandRepository } from "./repository.js";

/** Self-hosted adapter that keeps immutable content and canvas visibility atomic in SQLite. */
export class SqliteAuthoritativeCanvasCommitStore implements AuthoritativeCanvasCommitPort {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly contentVersions: ContentVersionRepository,
    private readonly canvasCommands: CanvasCommandRepository
  ) {}

  commit(input: Parameters<AuthoritativeCanvasCommitPort["commit"]>[0]) {
    return inWriteTransaction(this.database, () => {
      this.contentVersions.advanceHeadForSqliteCommit({
        scope: input.content.scope,
        expectedRevision: input.content.expectedRevision,
        content: input.content.version
      });
      return this.canvasCommands.commitAcceptedInCallerTransaction(input.accepted);
    });
  }
}
