import * as admin from "firebase-admin";
import { ApiClient, DecisionKind, DecisionRecord, DecisionStore, OutcomeInput } from "./types";

/**
 * Firestore 実装。コレクション（すべてクライアントからはアクセス不可。firestore.rules の default deny）:
 *  - decisionApiClients/{clientId}            { name, keyHash, isActive, dailyLimit, createdAt }
 *  - decisionApiClients/{clientId}/usage/{day} { count }
 *  - decisionLog/{decisionId}                  DecisionRecord + hasOutcome
 *  - decisionLog/{decisionId}/outcomes/{auto}  成果の全履歴（latestOutcome は最新のみ）
 */
export const CLIENTS_COLLECTION = "decisionApiClients";
export const DECISIONS_COLLECTION = "decisionLog";
const DEFAULT_DAILY_LIMIT = 500;

export class FirestoreDecisionStore implements DecisionStore {
  constructor(private readonly db: admin.firestore.Firestore) {}

  async findClientByKeyHash(keyHash: string): Promise<ApiClient | null> {
    const snap = await this.db.collection(CLIENTS_COLLECTION).where("keyHash", "==", keyHash).limit(1).get();
    const doc = snap.docs[0];
    if (!doc) return null;
    const d = doc.data();
    return {
      clientId: doc.id,
      name: String(d.name ?? doc.id),
      isActive: d.isActive === true,
      dailyLimit: typeof d.dailyLimit === "number" ? d.dailyLimit : DEFAULT_DAILY_LIMIT,
    };
  }

  async incrementDailyUsage(clientId: string, day: string): Promise<number> {
    const ref = this.db.collection(CLIENTS_COLLECTION).doc(clientId).collection("usage").doc(day);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const next = ((snap.data()?.count as number | undefined) ?? 0) + 1;
      tx.set(ref, { count: next, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return next;
    });
  }

  async saveDecision(record: DecisionRecord): Promise<void> {
    await this.db
      .collection(DECISIONS_COLLECTION)
      .doc(record.decisionId)
      .set({ ...stripUndefined(record), hasOutcome: false });
  }

  async getDecision(decisionId: string): Promise<DecisionRecord | null> {
    const snap = await this.db.collection(DECISIONS_COLLECTION).doc(decisionId).get();
    return snap.exists ? toRecord(snap.data()) : null;
  }

  async addOutcome(decisionId: string, outcome: OutcomeInput & { observedAt: string }): Promise<DecisionRecord | null> {
    const ref = this.db.collection(DECISIONS_COLLECTION).doc(decisionId);
    const clean = stripUndefined(outcome);
    const updated = await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const count = ((snap.data()?.outcomeCount as number | undefined) ?? 0) + 1;
      tx.update(ref, { latestOutcome: clean, outcomeCount: count, hasOutcome: true });
      tx.create(ref.collection("outcomes").doc(), { ...clean, receivedAt: admin.firestore.FieldValue.serverTimestamp() });
      return { ...toRecord(snap.data()), latestOutcome: outcome, outcomeCount: count };
    });
    return updated;
  }

  async listDecisionsWithOutcome(clientId: string, kind: DecisionKind, topic: string, limit: number): Promise<DecisionRecord[]> {
    const snap = await this.db
      .collection(DECISIONS_COLLECTION)
      .where("clientId", "==", clientId)
      .where("kind", "==", kind)
      .where("topic", "==", topic)
      .where("hasOutcome", "==", true)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();
    return snap.docs.map((d) => toRecord(d.data()));
  }
}

function toRecord(data: admin.firestore.DocumentData | undefined): DecisionRecord {
  const { hasOutcome: _ignored, ...rest } = (data ?? {}) as DecisionRecord & { hasOutcome?: boolean };
  return rest;
}

/** Firestore は undefined を保存できないので落とす */
function stripUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
