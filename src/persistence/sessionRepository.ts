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

export class SessionRepository {
  private databasePromise: Promise<IDBDatabase> | null = null;
  private autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
        database.addEventListener('versionchange', () => database.close());
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

  async save(session: Session): Promise<Session> {
    const database = await this.open();
    session.updatedAt = new Date().toISOString();
    const copy =
      session.schemaVersion === CURRENT_SESSION_SCHEMA ? validateCurrentSession(session) : migrateSession(session);
    const transaction = database.transaction(SESSION_STORE, 'readwrite');
    transaction.objectStore(SESSION_STORE).put(copy);
    await transactionComplete(transaction);
    return copy;
  }

  async get(sessionId: string): Promise<Session | null> {
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
    return valid.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async delete(sessionId: string): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(SESSION_STORE, 'readwrite');
    transaction.objectStore(SESSION_STORE).delete(sessionId);
    await transactionComplete(transaction);
  }

  scheduleAutosave(session: Session, delayMs = 500, onError?: (error: Error) => void): void {
    const existing = this.autosaveTimers.get(session.id);
    if (existing) clearTimeout(existing);
    this.autosaveTimers.set(
      session.id,
      setTimeout(() => {
        this.autosaveTimers.delete(session.id);
        void this.save(session).catch((error: unknown) => {
          const resolved = error instanceof Error ? error : new Error(String(error));
          console.error('Session autosave failed.', resolved);
          onError?.(resolved);
        });
      }, delayMs)
    );
  }

  close(): void {
    for (const timer of this.autosaveTimers.values()) clearTimeout(timer);
    this.autosaveTimers.clear();
    void this.databasePromise?.then((database) => database.close());
    this.databasePromise = null;
  }
}

export const sessionRepository = new SessionRepository();
