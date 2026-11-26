import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MemoryDecisionStore, StoreSnapshot } from "./memoryStore";

/** ローカルモードの保存先（リポジトリの外。誤コミット防止） */
export const DEFAULT_LOCAL_DATA_PATH = join(homedir(), ".decision-api", "data.json");

const EMPTY: StoreSnapshot = { clients: {}, usage: {}, decisions: {} };

function loadSnapshot(path: string): StoreSnapshot {
  if (!existsSync(path)) return structuredClone(EMPTY);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoreSnapshot>;
  return { clients: parsed.clients ?? {}, usage: parsed.usage ?? {}, decisions: parsed.decisions ?? {} };
}

/** 一時ファイルに書いてから rename（書き込み途中で落ちてもファイルが壊れない）。本人だけ読める権限 */
function saveSnapshot(path: string, snapshot: StoreSnapshot): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

const lockPath = (path: string) => `${path}.lock`;

/** 同じデータファイルを使うサーバーが起動中なら、その PID を返す */
export function findRunningServer(path = DEFAULT_LOCAL_DATA_PATH): number | null {
  if (!existsSync(lockPath(path))) return null;
  const pid = Number(readFileSync(lockPath(path), "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null; // 異常終了で残ったロック
  }
}

/** サーバー起動中であることを示すロックを置き、解除関数を返す */
export function acquireServerLock(path = DEFAULT_LOCAL_DATA_PATH): () => void {
  const running = findRunningServer(path);
  if (running) throw new Error(`同じデータファイルを使うサーバーが起動中です（PID ${running}）`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(lockPath(path), String(process.pid), { mode: 0o600 });
  return () => {
    if (existsSync(lockPath(path)) && readFileSync(lockPath(path), "utf8").trim() === String(process.pid)) rmSync(lockPath(path));
  };
}

/**
 * ローカルモード用: JSON ファイルに永続化するストア（GCP 不要）。
 * 1プロセスから使う前提（同じファイルを複数プロセスで同時に書かない）。
 */
export function createFileDecisionStore(path = DEFAULT_LOCAL_DATA_PATH): MemoryDecisionStore {
  return new MemoryDecisionStore(loadSnapshot(path), (snapshot) => saveSnapshot(path, snapshot));
}
