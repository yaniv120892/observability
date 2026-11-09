export const DEADLINE_PASSED = Symbol('deadline passed');

/** `work`'s value, or `DEADLINE_PASSED` once `deadlineMs` has gone by; `work` is not cancelled. */
export async function beforeDeadline<Value>({
  work,
  deadlineMs,
}: {
  work: Promise<Value>;
  deadlineMs: number;
}): Promise<Value | typeof DEADLINE_PASSED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof DEADLINE_PASSED>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE_PASSED), deadlineMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
