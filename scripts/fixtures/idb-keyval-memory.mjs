const memory = globalThis.__THOUGHTDAG_TEST_IDB__ ??= new Map();

export async function get(key) {
  return memory.get(key);
}

export async function set(key, value) {
  memory.set(key, value);
}

export async function del(key) {
  memory.delete(key);
}

export async function keys() {
  return [...memory.keys()];
}
