/**
 * 全局 KV 配置
 * 用于在不同模块间共享 KV namespace 绑定
 */

let kvStore = null;

export function setKvStore(kv) {
  kvStore = kv;
}

export function getKvStore() {
  return kvStore;
}
