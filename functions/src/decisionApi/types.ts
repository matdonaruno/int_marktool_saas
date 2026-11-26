import { CreativeForCritic, CriticReferenceExample } from "../utils/criticAgent";

export type DecisionKind = "critic" | "decide";

/** 成果のどの数値で良し悪しを測るか（フィードバックループの評価軸） */
export interface TargetMetric {
  name: string;
  direction: "higher" | "lower";
}

export interface DecideOption {
  id: string;
  label: string;
  description?: string;
}

export interface CriticRequest {
  creative: CreativeForCritic;
  context?: string;
  topic: string;
  targetMetric: TargetMetric;
}

export interface DecideRequest {
  question: string;
  options: DecideOption[];
  criteria: string[];
  context?: string;
  topic: string;
  targetMetric: TargetMetric;
}

export interface OutcomeInput {
  metrics: Record<string, number>;
  observedAt?: string;
  note?: string;
}

export interface CriticResult {
  score: number;
  isPassed: boolean;
  weaknesses: string[];
  improvementInstruction: string;
}

export interface DecideResult {
  recommendation: string;
  confidence: number;
  reasoning: string;
  keyFactors: string[];
  risks: string[];
  whatWouldChangeMyMind: string;
}

/** 過去の判断とその実績（decide 用 few-shot） */
export interface DecideReferenceExample {
  question: string;
  recommendation: string;
  outcomeSummary: string;
  outcomeLabel: "winner" | "loser";
}

export interface EngineMeta {
  usedModelId: string;
  promptVersion: string;
  latencyMs: number;
}

export interface DecisionRecord {
  decisionId: string;
  clientId: string;
  kind: DecisionKind;
  topic: string;
  targetMetric: TargetMetric;
  input: CriticRequest | DecideRequest;
  output: CriticResult | DecideResult;
  meta: EngineMeta & { referenceCount: number };
  createdAt: string;
  latestOutcome?: OutcomeInput & { observedAt: string };
  outcomeCount: number;
}

export interface ApiClient {
  clientId: string;
  name: string;
  isActive: boolean;
  dailyLimit: number;
}

/** 永続化のポート（Firestore 実装とメモリ実装がある） */
export interface DecisionStore {
  findClientByKeyHash(keyHash: string): Promise<ApiClient | null>;
  incrementDailyUsage(clientId: string, day: string): Promise<number>;
  saveDecision(record: DecisionRecord): Promise<void>;
  getDecision(decisionId: string): Promise<DecisionRecord | null>;
  addOutcome(decisionId: string, outcome: OutcomeInput & { observedAt: string }): Promise<DecisionRecord | null>;
  /** 同じ client・kind・topic の、成果が付いた判断（新しい順、最大 limit 件） */
  listDecisionsWithOutcome(clientId: string, kind: DecisionKind, topic: string, limit: number): Promise<DecisionRecord[]>;
}

/** AI 判断のポート（Gemini 実装とテスト用フェイクがある） */
export interface DecisionEngine {
  critic(req: CriticRequest, references: CriticReferenceExample[]): Promise<{ result: CriticResult; meta: EngineMeta }>;
  decide(req: DecideRequest, references: DecideReferenceExample[]): Promise<{ result: DecideResult; meta: EngineMeta }>;
}
