import { unpackVector } from "../../../src/vector.ts";

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
