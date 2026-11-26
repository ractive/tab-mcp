/**
 * An access token written straight into a token store, without OAuth: for
 * `tokenFor` (`./testing`) and this repository's tests. Nothing the relay
 * runs imports it, so it is not in `main.js` or `index.js`.
 */

import type { TokenRecord, TokenStore } from "./store/types.ts";
import { hashToken, newId, newToken } from "./tokens.ts";

export async function issueAccessToken(
	store: TokenStore,
	grant: {
		grantId?: string;
		addressId: string;
		app: string;
		clientId: string;
		clientName: string;
		subject?: string;
		/** A group grant's group (DEC-232); `addressId` is then `groupAddress(group)`. */
		group?: string;
	},
	options: { ttlMs: number; now?: number },
): Promise<{ token: string; record: TokenRecord }> {
	const now = options.now ?? Date.now();
	const token = newToken("access");
	const record: TokenRecord = {
		hash: hashToken(token),
		kind: "access",
		grantId: grant.grantId ?? newId("g"),
		addressId: grant.addressId,
		app: grant.app,
		clientId: grant.clientId,
		clientName: grant.clientName,
		scopes: ["tools"],
		grantCreatedAt: now,
		issuedAt: now,
		expiresAt: now + options.ttlMs,
	};
	if (grant.subject !== undefined) record.subject = grant.subject;
	if (grant.group !== undefined) record.group = grant.group;
	await store.put(record);
	return { token, record };
}
