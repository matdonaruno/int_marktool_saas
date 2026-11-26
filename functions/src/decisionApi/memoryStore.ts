import { ApiClient, DecisionKind, DecisionRecord, DecisionStore, OutcomeInput } from "./types";

/** テスト・ローカル開発用のメモリ実装（本番は firestoreStore） */
export class MemoryDecisionStore implements DecisionStore {
  private readonly clients = new Map<string, ApiClient>();
  private readonly usage = new Map<string, number>();
  private readonly decisions = new Map<string, DecisionRecord>();

  addClient(keyHash: string, client: ApiClient): void {
    this.clients.set(keyHash, client);
  }

  async findClientByKeyHash(keyHash: string): Promise<ApiClient | null> {
    return this.clients.get(keyHash) ?? null;
  }

  async incrementDailyUsage(clientId: string, day: string): Promise<number> {
    const key = `${clientId}:${day}`;
    const next = (this.usage.get(key) ?? 0) + 1;
    this.usage.set(key, next);
    return next;
  }

  async saveDecision(record: DecisionRecord): Promise<void> {
    this.decisions.set(record.decisionId, structuredClone(record));
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
