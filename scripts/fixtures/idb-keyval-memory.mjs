const memory = globalThis.__THOUGHTDAG_TEST_IDB__ ??= new Map();

export async function get(key) {
  await globalThis.__THOUGHTDAG_TEST_IDB_HOOK__?.('get', key);
  return memory.get(key);
}

export async function set(key, value) {
  await globalThis.__THOUGHTDAG_TEST_IDB_HOOK__?.('set', key, value);
  memory.set(key, value);
}

export async function del(key) {
  await globalThis.__THOUGHTDAG_TEST_IDB_HOOK__?.('del', key);
  memory.delete(key);
}

export async function keys() {
  return [...memory.keys()];
}
