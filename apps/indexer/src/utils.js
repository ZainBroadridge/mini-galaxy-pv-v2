export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorText(error) {
  return String(error?.shortMessage ?? error?.reason ?? error?.message ?? error);
}

export function permanentError(message) {
  const error = new Error(message);
  error.permanent = true;
  return error;
}

export async function mapWithConcurrency(values, concurrency, mapper) {
  const output = new Array(values.length);
  let cursor = 0;
  async function run() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, run));
  return output;
}
