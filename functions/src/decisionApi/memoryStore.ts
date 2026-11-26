import { ApiClient, DecisionKind, DecisionRecord, DecisionStore, OutcomeInput } from "./types";

/** メモリストアの中身（ファイル保存・復元用） */
export interface StoreSnapshot {
  clients: Record<string, ApiClient>;
  usage: Record<string, number>;
  decisions: Record<string, DecisionRecord>;
}

/**
 * メモリ実装。テスト・ローカル開発用（本番は firestoreStore）。
 * onChange を渡すと、変更のたびにスナップショットを渡す（fileStore が永続化に使う）。
 */
export class MemoryDecisionStore implements DecisionStore {
  private readonly clients = new Map<string, ApiClient>();
  private readonly usage = new Map<string, number>();
  private readonly decisions = new Map<string, DecisionRecord>();

  constructor(snapshot?: StoreSnapshot, private readonly onChange?: (snapshot: StoreSnapshot) => void) {
    if (!snapshot) return;
    Object.entries(snapshot.clients).forEach(([k, v]) => this.clients.set(k, v));
    Object.entries(snapshot.usage).forEach(([k, v]) => this.usage.set(k, v));
    Object.entries(snapshot.decisions).forEach(([k, v]) => this.decisions.set(k, v));
  }

  toSnapshot(): StoreSnapshot {
    return structuredClone({
      clients: Object.fromEntries(this.clients),
      usage: Object.fromEntries(this.usage),
      decisions: Object.fromEntries(this.decisions),
    });
  }

  private changed(): void {
    this.onChange?.(this.toSnapshot());
  }

  /** 同じ clientId のキーは差し替える（ローテーション） */
  addClient(keyHash: string, client: ApiClient): void {
    for (const [hash, c] of this.clients) if (c.clientId === client.clientId) this.clients.delete(hash);
    this.clients.set(keyHash, client);
    this.changed();
  }

  revokeClient(clientId: string): boolean {
    let found = false;
    for (const c of this.clients.values()) {
      if (c.clientId === clientId) {
        c.isActive = false;
        found = true;
      }
    }
    if (found) this.changed();
    return found;
  }

  async findClientByKeyHash(keyHash: string): Promise<ApiClient | null> {
    return this.clients.get(keyHash) ?? null;
  }

  async incrementDailyUsage(clientId: string, day: string): Promise<number> {
    const key = `${clientId}:${day}`;
    const next = (this.usage.get(key) ?? 0) + 1;
    this.usage.set(key, next);
    this.changed();
    return next;
  }

  async saveDecision(record: DecisionRecord): Promise<void> {
    this.decisions.set(record.decisionId, structuredClone(record));
    this.changed();
  }

  async getDecision(decisionId: string): Promise<DecisionRecord | null> {
    const r = this.decisions.get(decisionId);
    return r ? structuredClone(r) : null;
  }

  async addOutcome(decisionId: string, outcome: OutcomeInput & { observedAt: string }): Promise<DecisionRecord | null> {
    const r = this.decisions.get(decisionId);
    if (!r) return null;
    r.latestOutcome = outcome;
    r.outcomeCount += 1;
    this.changed();
    return structuredClone(r);
  }

  async listDecisionsWithOutcome(clientId: string, kind: DecisionKind, topic: string, limit: number): Promise<DecisionRecord[]> {
    return [...this.decisions.values()]
      .filter((r) => r.clientId === clientId && r.kind === kind && r.topic === topic && r.latestOutcome)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }
}
