import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");

/** 扫雷游戏仓：环境变量优先，默认相邻兄弟目录；缺失时明确失败。 */
export function resolveGameRepo() {
  const fromEnv = process.env.DSH_MINESWEEPING_REPO;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return path.resolve(fromEnv);
  return path.resolve(REPO_ROOT, "..", "dsh-game-minesweeping");
}

export { REPO_ROOT };
