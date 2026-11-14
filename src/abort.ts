/** Stop waiting even if a host port fails to honor the supplied signal. */
export async function untilAborted<T>(
	signal: AbortSignal | undefined,
	operation: () => Promise<T>,
): Promise<T> {
	if (!signal) return operation();
	signal.throwIfAborted();
	let abort!: () => void;
	const aborted = new Promise<never>((_, reject) => {
		abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
	});
	try {
		return await Promise.race([
			aborted,
			Promise.resolve().then(() => {
				signal.throwIfAborted();
				return operation();
			}),
		]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
