/**
 * IP address parsing and the public-address check used by the CIMD fetcher's
 * SSRF guard (threat model A3) and by log truncation (A9).
 */

/** Parse dotted-quad IPv4 into four octets, or undefined. */
export function parseIpv4(ip: string): number[] | undefined {
	const parts = ip.split(".");
	if (parts.length !== 4) return undefined;
	const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1));
	return octets.every((o) => o >= 0 && o <= 255) ? octets : undefined;
}

/** Parse IPv6 (with `::`, an optional zone, an embedded IPv4 tail) into 8 groups. */
export function parseIpv6(ip: string): number[] | undefined {
	const address = ip.split("%")[0] ?? "";
	const halves = address.split("::");
	if (halves.length > 2) return undefined;
	const parseSide = (side: string): number[] | undefined => {
		if (side === "") return [];
		const groups: number[] = [];
		const items = side.split(":");
		for (const [i, item] of items.entries()) {
			if (i === items.length - 1 && item.includes(".")) {
				const v4 = parseIpv4(item);
				if (v4 === undefined) return undefined;
				groups.push(
					((v4[0] ?? 0) << 8) | (v4[1] ?? 0),
					((v4[2] ?? 0) << 8) | (v4[3] ?? 0),
				);
			} else if (/^[0-9a-fA-F]{1,4}$/.test(item)) {
				groups.push(Number.parseInt(item, 16));
			} else {
				return undefined;
			}
		}
		return groups;
	};
	const head = parseSide(halves[0] ?? "");
	const tail = halves.length === 2 ? parseSide(halves[1] ?? "") : [];
	if (head === undefined || tail === undefined) return undefined;
	if (halves.length === 1) return head.length === 8 ? head : undefined;
	const missing = 8 - head.length - tail.length;
	if (missing < 1) return undefined;
	return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/** IPv4 ranges that are not globally reachable unicast (RFC 6890 and friends). */
const PRIVATE_V4: [number, number, number, number, number][] = [
	[0, 0, 0, 0, 8], // "this network"
	[10, 0, 0, 0, 8], // private
	[100, 64, 0, 0, 10], // CGNAT
	[127, 0, 0, 0, 8], // loopback
	[169, 254, 0, 0, 16], // link-local (cloud metadata lives here)
	[172, 16, 0, 0, 12], // private
	[192, 0, 0, 0, 24], // IETF protocol assignments
	[192, 0, 2, 0, 24], // TEST-NET-1
	[192, 88, 99, 0, 24], // 6to4 relay anycast
	[192, 168, 0, 0, 16], // private
	[198, 18, 0, 0, 15], // benchmarking
	[198, 51, 100, 0, 24], // TEST-NET-2
	[203, 0, 113, 0, 24], // TEST-NET-3
	[224, 0, 0, 0, 4], // multicast
	[240, 0, 0, 0, 4], // reserved, broadcast
];

function v4Number(o: number[]): number {
	return (
		(((o[0] ?? 0) << 24) >>> 0) +
		((o[1] ?? 0) << 16) +
		((o[2] ?? 0) << 8) +
		(o[3] ?? 0)
	);
}

function isPublicV4(octets: number[]): boolean {
	const n = v4Number(octets);
	return PRIVATE_V4.every(([a, b, c, d, bits]) => {
		const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
		return (n & mask) >>> 0 !== (v4Number([a, b, c, d]) & mask) >>> 0;
	});
}

function isPublicV6(g: number[]): boolean {
	const [g0 = 0, g1 = 0] = g;
	// IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64
	// (64:ff9b::a.b.c.d): judge the embedded IPv4 address.
	const embedded = [
		(g[6] ?? 0) >> 8,
		(g[6] ?? 0) & 0xff,
		(g[7] ?? 0) >> 8,
		(g[7] ?? 0) & 0xff,
	];
	if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
		return g[5] === 0xffff && isPublicV4(embedded);
	}
	if (g0 === 0x64 && g1 === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
		return isPublicV4(embedded);
	}
	// Only global unicast (2000::/3) ...
	if ((g0 & 0xe000) !== 0x2000) return false;
	// ... without the special-purpose blocks inside it.
	if (g0 === 0x2001 && g1 < 0x0200) return false; // 2001::/23 (Teredo, benchmarking, ORCHID)
	if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
	if (g0 === 0x2002) return false; // 6to4 (may embed a private IPv4)
	if (g0 === 0x3fff && g1 < 0x1000) return false; // documentation (3fff::/20)
	return true;
}

/**
 * Whether an IP address (v4 or v6 text) is a globally reachable unicast
 * address. Anything that does not parse counts as not public.
 */
export function isPublicIp(ip: string): boolean {
	const v4 = parseIpv4(ip);
	if (v4 !== undefined) return isPublicV4(v4);
	const v6 = parseIpv6(ip.replace(/^\[|\]$/g, ""));
	if (v6 !== undefined) return isPublicV6(v6);
	return false;
}

/** Whether a URL hostname is a loopback name or address. */
export function isLoopbackHost(hostname: string): boolean {
	const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (h === "localhost" || h.endsWith(".localhost")) return true;
	const v4 = parseIpv4(h);
	if (v4 !== undefined) return v4[0] === 127;
	const v6 = parseIpv6(h);
	return v6?.slice(0, 7).every((x) => x === 0) === true && v6[7] === 1;
}
