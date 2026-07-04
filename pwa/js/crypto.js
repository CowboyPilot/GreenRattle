/*
AES-256-GCM message encryption and key management.

Wire format inside the fixed 170-byte Rattlegram payload:

  bytes 0-1   ASCII key identifier, two uppercase hex chars.
              "00" means unencrypted.
  unencrypted:
  bytes 2..   UTF-8 text, NUL padded to 170.
  encrypted:
  byte  2     ciphertext length N (ciphertext includes the 16-byte GCM tag)
  bytes 3-14  96-bit random IV
  bytes 15..  N bytes of AES-256-GCM ciphertext, NUL padded to 170.

The two ID bytes are also passed as GCM additional authenticated data, so a
message can only decrypt under the key ID it was sent with.

Max text length: 168 bytes unencrypted, 139 bytes encrypted.
*/

const PAYLOAD_SIZE = 170;
const PLAIN_ID = "00";
const MAX_KEYS = 10;
const STORE_KEY = "rgm_keys";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const MAX_PLAIN_BYTES = PAYLOAD_SIZE - 2;
export const MAX_CIPHER_BYTES = PAYLOAD_SIZE - 2 - 1 - 12 - 16;

// ---------- keystore ----------

let keys = loadKeys();

function loadKeys() {
	try {
		const raw = localStorage.getItem(STORE_KEY);
		if (!raw)
			return [];
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter(k => validId(k.id) && k.key) : [];
	} catch (e) {
		return [];
	}
}

function saveKeys() {
	localStorage.setItem(STORE_KEY, JSON.stringify(keys));
}

export function listKeys() {
	return keys.map(k => ({ id: k.id, created: k.created }));
}

export function getKey(id) {
	return keys.find(k => k.id === id) || null;
}

export function validId(id) {
	return typeof id === "string" && /^[0-9A-F]{2}$/.test(id) && id !== PLAIN_ID;
}

export function generateKey() {
	if (keys.length >= MAX_KEYS)
		throw new Error(`Key store is full (${MAX_KEYS} keys). Delete a key first.`);
	const raw = crypto.getRandomValues(new Uint8Array(32));
	let id;
	do {
		const b = crypto.getRandomValues(new Uint8Array(1))[0];
		id = b.toString(16).toUpperCase().padStart(2, "0");
	} while (id === PLAIN_ID || getKey(id));
	const entry = {
		id,
		key: bytesToBase64(raw),
		created: new Date().toISOString(),
	};
	keys.push(entry);
	saveKeys();
	return entry;
}

export function importKey(entry) {
	if (!entry || entry.type !== "aes256-key" || !validId(entry.id))
		throw new Error("Not a valid key file.");
	const raw = base64ToBytes(entry.key);
	if (raw.length !== 32)
		throw new Error("Key is not 256 bits.");
	const existing = getKey(entry.id);
	if (existing) {
		if (existing.key === entry.key)
			return { entry: existing, replaced: false };
		existing.key = entry.key;
		existing.created = entry.created || new Date().toISOString();
		saveKeys();
		return { entry: existing, replaced: true };
	}
	if (keys.length >= MAX_KEYS)
		throw new Error(`Key store is full (${MAX_KEYS} keys). Delete a key first.`);
	const stored = {
		id: entry.id,
		key: entry.key,
		created: entry.created || new Date().toISOString(),
	};
	keys.push(stored);
	saveKeys();
	return { entry: stored, replaced: false };
}

export function deleteKey(id) {
	keys = keys.filter(k => k.id !== id);
	saveKeys();
}

// Serializable form used for both the key file and the QR code.
export function exportKey(id) {
	const k = getKey(id);
	if (!k)
		throw new Error(`No key ${id}.`);
	return JSON.stringify({
		app: "greenrattle",
		type: "aes256-key",
		id: k.id,
		key: k.key,
		created: k.created,
	});
}

export function parseKeyText(text) {
	let obj;
	try {
		obj = JSON.parse(text);
	} catch (e) {
		throw new Error("Not a valid key file.");
	}
	return importKey(obj);
}

// ---------- payload encode / decode ----------

async function subtleKey(entry, usage) {
	return crypto.subtle.importKey("raw", base64ToBytes(entry.key),
		{ name: "AES-GCM" }, false, [usage]);
}

// Returns a 170-byte Uint8Array ready for the modem.
export async function buildPayload(text, keyId) {
	const payload = new Uint8Array(PAYLOAD_SIZE);
	const textBytes = textEncoder.encode(text);
	if (!keyId || keyId === PLAIN_ID) {
		if (textBytes.length > MAX_PLAIN_BYTES)
			throw new Error(`Message too long (${textBytes.length} of ${MAX_PLAIN_BYTES} bytes).`);
		payload.set(textEncoder.encode(PLAIN_ID), 0);
		payload.set(textBytes, 2);
		return payload;
	}
	const entry = getKey(keyId);
	if (!entry)
		throw new Error(`No key ${keyId} in the key store.`);
	if (textBytes.length > MAX_CIPHER_BYTES)
		throw new Error(`Encrypted message too long (${textBytes.length} of ${MAX_CIPHER_BYTES} bytes).`);
	const idBytes = textEncoder.encode(entry.id);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const key = await subtleKey(entry, "encrypt");
	const ct = new Uint8Array(await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: idBytes }, key, textBytes));
	payload.set(idBytes, 0);
	payload[2] = ct.length;
	payload.set(iv, 3);
	payload.set(ct, 15);
	return payload;
}

// Parses a received 170-byte payload.
// Returns { text, keyId, encrypted, error } - error is set when the payload
// is flagged encrypted but cannot be decrypted (unknown key, tampering).
export async function parsePayload(payloadBytes) {
	const id = safeAscii(payloadBytes.subarray(0, 2));
	if (id === PLAIN_ID)
		return { text: trimZeros(payloadBytes.subarray(2)), keyId: PLAIN_ID, encrypted: false };
	if (!/^[0-9A-F]{2}$/.test(id)) {
		// No recognizable header - message from a stock Rattlegram client.
		return { text: trimZeros(payloadBytes), keyId: null, encrypted: false, legacy: true };
	}
	const entry = getKey(id);
	if (!entry)
		return { keyId: id, encrypted: true, error: `No key ${id} - cannot decrypt.` };
	const len = payloadBytes[2];
	if (len < 16 || 15 + len > PAYLOAD_SIZE)
		return { keyId: id, encrypted: true, error: "Corrupt encrypted message." };
	const iv = payloadBytes.subarray(3, 15);
	const ct = payloadBytes.subarray(15, 15 + len);
	try {
		const key = await subtleKey(entry, "decrypt");
		const pt = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv, additionalData: textEncoder.encode(id) }, key, ct);
		return { text: textDecoder.decode(pt), keyId: id, encrypted: true };
	} catch (e) {
		return { keyId: id, encrypted: true, error: `Decryption with key ${id} failed.` };
	}
}

// ---------- helpers ----------

function trimZeros(bytes) {
	let end = bytes.length;
	while (end > 0 && bytes[end - 1] === 0)
		end--;
	return textDecoder.decode(bytes.subarray(0, end));
}

function safeAscii(bytes) {
	return String.fromCharCode(...bytes);
}

export function bytesToBase64(bytes) {
	let bin = "";
	for (const b of bytes)
		bin += String.fromCharCode(b);
	return btoa(bin);
}

export function base64ToBytes(b64) {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++)
		out[i] = bin.charCodeAt(i);
	return out;
}
