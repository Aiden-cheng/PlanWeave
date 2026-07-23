export type ReconnectBackoffOptions = {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
};

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`agent_host_${name}_invalid`);
  }
  return value;
}

export function parseReconnectBackoffOptions(
  input: Partial<ReconnectBackoffOptions> = {}
): ReconnectBackoffOptions {
  const initialDelayMs = positiveSafeInteger(
    input.initialDelayMs ?? 250,
    "reconnect_initial_delay"
  );
  const maxDelayMs = positiveSafeInteger(input.maxDelayMs ?? 30_000, "reconnect_max_delay");
  if (initialDelayMs > maxDelayMs) {
    throw new Error("agent_host_reconnect_delay_range_invalid");
  }
  return { initialDelayMs, maxDelayMs };
}

/**
 * Equal-jitter delay for the one-based reconnect attempt:
 * cap = min(maxDelay, initialDelay * 2^(attempt - 1));
 * delay = max(1, floor(cap / 2 + random * cap / 2)).
 */
export function reconnectDelay(
  attempt: number,
  random: () => number,
  options: ReconnectBackoffOptions
): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("agent_host_reconnect_attempt_invalid");
  }
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new Error("agent_host_reconnect_random_invalid");
  }
  const exponent = Math.min(attempt - 1, 52);
  const cap = Math.min(options.maxDelayMs, options.initialDelayMs * 2 ** exponent);
  return Math.max(1, Math.floor(cap / 2 + sample * (cap / 2)));
}
