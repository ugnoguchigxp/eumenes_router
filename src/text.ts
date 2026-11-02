/** Cuts at a code point boundary: a surrogate pair is never split. */
export function head(text: string, limit: number) {
	if (text.length <= limit) return text;
	const code = text.charCodeAt(limit - 1);
	return text.slice(0, code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit);
}

export function tail(text: string, limit: number) {
	if (text.length <= limit) return text;
	const code = text.charCodeAt(text.length - limit);
	return text.slice(
		text.length - limit + (code >= 0xdc00 && code <= 0xdfff ? 1 : 0),
	);
}
