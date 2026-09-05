import type { Session } from '../domain/session';
import { CURRENT_SESSION_SCHEMA, migrateSession, validateCurrentSession } from '../domain/migrations';

const DATABASE_NAME = 'signalforge';
const DATABASE_VERSION = 1;
const SESSION_STORE = 'sessions';

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error || new Error('IndexedDB request failed.')));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve());
    transaction.addEventListener('abort', () =>
      reject(transaction.error || new Error('IndexedDB transaction aborted.'))
    );
    transaction.addEventListener('error', () =>
      reject(transaction.error || new Error('IndexedDB transaction failed.'))
    );
  });
}

/** Thrown when a save would overwrite a newer stored revision (another tab or a stale autosave). */
export class SessionConflictError extends Error {
  readonly sessionId: string;
  readonly storedRevision: number;
  readonly attemptedRevision: number;

  constructor(sessionId: string, storedRevision: number, attemptedRevision: number) {
    super(
      `Session ${sessionId} was modified elsewhere (stored revision ${storedRevision}, this copy is revision ${attemptedRevision}). Reload the session before saving to avoid overwriting newer work.`
    );
    this.name = 'SessionConflictError';
    this.sessionId = sessionId;
    this.storedRevision = storedRevision;
    this.attemptedRevision = attemptedRevision;
  }
}

export class SessionRepository {
  private databasePromise: Promise<IDBDatabase> | null = null;
  private autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private saveQueues = new Map<string, Promise<Session>>();
  private readonly factory: IDBFactory | null;
  listWarnings: string[] = [];

  constructor(factory?: IDBFactory) {
    this.factory = factory || null;
  }

  private open(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    const factory = this.factory || globalThis.indexedDB;
    if (!factory) return Promise.reject(new Error('IndexedDB is not available in this environment.'));
    this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
      request.addEventListener('upgradeneeded', () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(SESSION_STORE)) {
          const store = database.createObjectStore(SESSION_STORE, { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt');
          store.createIndex('name', 'name');
        }
      });
      request.addEventListener('success', () => {
        const database = request.result;
        database.addEventListener('versionchange', () => {
          // Another tab is upgrading or deleting the database: release our handle and reopen lazily.
          database.close();
          this.databasePromise = null;
        });
        resolve(database);
      });
      request.addEventListener('error', () => {
        this.databasePromise = null;
        reject(request.error || new Error('Could not open SignalForge storage.'));
      });
      request.addEventListener('blocked', () => {
        this.databasePromise = null;
        reject(new Error('SignalForge storage upgrade is blocked by another open tab.'));
      });
    });
    return this.databasePromise;
  }

  /**
   * Persists the session with optimistic concurrency: the stored revision is read inside the same
   * read-write transaction and the write is refused when it differs from the revision this copy was
   * loaded with. Successful saves increment the revision on both the stored record and `session`.
   */
  async save(session: Session): Promise<Session> {
    const previous = this.saveQueues.get(session.id);
    const operation = (async () => {
      if (previous) await previous.catch(() => undefined);
      return this.performSave(session);
    })();
    this.saveQueues.set(session.id, operation);
    try {
      return await operation;
    } finally {
      if (this.saveQueues.get(session.id) === operation) this.saveQueues.delete(session.id);
    }
  }

  private async performSave(session: Session): Promise<Session> {
    const database = await this.open();
    const previousUpdatedAt = session.updatedAt;
    session.updatedAt = new Date().toISOString();
    const copy =
      session.schemaVersion === CURRENT_SESSION_SCHEMA ? validateCurrentSession(session) : migrateSession(session);
    const transaction = database.transaction(SESSION_STORE, 'readwrite');
    const store = transaction.objectStore(SESSION_STORE);
    const stored = (await requestResult(store.get(copy.id))) as { revision?: unknown } | undefined;
    const storedRevision =
      stored && Number.isInteger(stored.revision) && (stored.revision as number) >= 0 ? (stored.revision as number) : 0;
    const attemptedRevision =
      Number.isInteger(copy.revision) && (copy.revision as number) >= 0 ? (copy.revision as number) : 0;
    if (stored && storedRevision !== attemptedRevision) {
      transaction.abort();
      session.updatedAt = previousUpdatedAt;
      throw new SessionConflictError(copy.id, storedRevision, attemptedRevision);
    }
    copy.revision = storedRevision + 1;
    session.revision = copy.revision;
    store.put(copy);
    await transactionComplete(transaction);
    return copy;
  }

  async get(sessionId: string): Promise<Session | null> {
    await this.saveQueues.get(sessionId)?.catch(() => undefined);
    const database = await this.open();
    const transaction = database.transaction(SESSION_STORE, 'readonly');
    const result = await requestResult(transaction.objectStore(SESSION_STORE).get(sessionId));
    await transactionComplete(transaction);
    return result ? migrateSession(result) : null;
  }

  async list(): Promise<Session[]> {
    const database = await this.open();
    const transaction = database.transaction(SESSION_STORE, 'readonly');
    const sessions = (await requestResult(transaction.objectStore(SESSION_STORE).getAll())) as Session[];
    await transactionComplete(transaction);
    const valid: Session[] = [];
    this.listWarnings = [];
    for (const session of sessions) {
      try {
        valid.push(migrateSession(session));
      } catch (error) {
        console.error('Skipped invalid stored session.', error);
        this.listWarnings.push(
          `A stored session (${typeof session?.id === 'string' ? session.id : 'unknown ID'}) is invalid and was not loaded.`
        );
      }
    }
    return valid.sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')));
  }

  async delete(sessionId: string): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(SESSION_STORE, 'readwrite');
    transaction.objectStore(SESSION_STORE).delete(sessionId);
    await transactionComplete(transaction);
  }

  scheduleAutosave(
    session: Session,
    delayMs = 500,
    onError?: (error: Error) => void,
    onSuccess?: (saved: Session) => void,
    onStart?: () => void
  ): void {
    const existing = this.autosaveTimers.get(session.id);
    if (existing) clearTimeout(existing);
    this.autosaveTimers.set(
      session.id,
      setTimeout(() => {
        this.autosaveTimers.delete(session.id);
        onStart?.();
        void this.save(session)
          .then((saved) => onSuccess?.(saved))
          .catch((error: unknown) => {
            const resolved = error instanceof Error ? error : new Error(String(error));
            console.error('Session autosave failed.', resolved);
            onError?.(resolved);
          });
      }, delayMs)
    );
  }

  /** Drops a pending autosave, e.g. when the caller reloads the same session from storage. */
  cancelAutosave(sessionId: string): void {
    const existing = this.autosaveTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    this.autosaveTimers.delete(sessionId);
  }

  close(): void {
    for (const timer of this.autosaveTimers.values()) clearTimeout(timer);
    this.autosaveTimers.clear();
    void this.databasePromise?.then((database) => database.close());
    this.databasePromise = null;
  }
}

export const sessionRepository = new SessionRepository();
