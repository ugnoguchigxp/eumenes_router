import { sha256Hex } from "./digest.ts";
import { routerErrors } from "./contracts/errors.ts";

/**
 * The vector space a stored embedding belongs to. The host names the space.
 * Vectors from two spaces are never compared.
 */
export type VectorSpace = {
	modelId: string;
	revision: string;
	artifactDigest: string;
	dimension: number;
};

/** Stable key of a vector space. The first 32 hex digits, as the product stores it. */
export function vectorSpaceKey(space: VectorSpace): string {
	return sha256Hex(
		JSON.stringify([
			space.modelId,
			space.revision,
			space.artifactDigest,
			space.dimension,
		]),
	).slice(0, 32);
}

/** Float32 values, in the platform's byte order, as a blob. */
export function packVector(values: readonly number[]): Uint8Array {
	return new Uint8Array(new Float32Array(values).buffer);
}

export function unpackVector(blob: Uint8Array): Float32Array {
	const copy = new Uint8Array(blob);
	return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
	return sum;
}

/**
 * Vectors stored as base64 of float32 little-endian, `count` × `dimension`.
 * Returns null when the text is not base64, the size is wrong, or a value is not finite.
 */
export function decodeVectors(
	base64: string,
	count: number,
	dimension: number,
): Float32Array[] | null {
	let binary: string;
	try {
		binary = atob(base64);
	} catch {
		return null;
	}
	if (binary.length !== count * dimension * 4) return null;
	const all = unpackVector(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
	for (const v of all) if (!Number.isFinite(v)) return null;
	return Array.from({ length: count }, (_, i) =>
		all.subarray(i * dimension, (i + 1) * dimension),
	);
}

export function encodeVectors(vectors: readonly Uint8Array[]): string {
	let binary = "";
	for (const bytes of vectors)
		for (let i = 0; i < bytes.length; i += 0x8000)
			binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

/** A space and a vector the package is willing to store or query. */
export function assertVector(space: VectorSpace, values: ArrayLike<number>) {
	if (
		typeof space.modelId !== "string" ||
		typeof space.revision !== "string" ||
		typeof space.artifactDigest !== "string" ||
		!Number.isInteger(space.dimension) ||
		space.dimension < 1 ||
		values.length !== space.dimension
	)
		throw new Error(routerErrors.invalidEmbedding);
	for (let i = 0; i < values.length; i++) {
		const value = values[i];
		if (typeof value !== "number" || !Number.isFinite(value))
			throw new Error(routerErrors.invalidEmbedding);
	}
}
