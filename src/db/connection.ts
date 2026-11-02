/** A value the host's driver can bind. The package never opens a connection. */
export type SqlValue = string | number | bigint | null | Uint8Array;

export type RunResult = { changes: number };

export type RouterStatement = {
	get(...params: SqlValue[]): unknown;
	all(...params: SqlValue[]): unknown[];
	run(...params: SqlValue[]): RunResult;
};

/**
 * The host's synchronous connection, borrowed for the call.
 * The host opens it, closes it, and runs the transaction around the call.
 */
export type RouterDb = {
	exec(sql: string): void;
	query(sql: string): RouterStatement;
};
