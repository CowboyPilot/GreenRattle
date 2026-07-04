import * as Crypto from "./crypto.js";
import { Modem } from "./modem.js";

const $ = (id) => document.getElementById(id);

// ---------- settings ----------

const defaults = {
	callSign: "ANONYMOUS",
	carrierFrequency: 1500,
	noiseSymbols: 6,
	fancyHeader: false,
	showSpectrum: false,
};

let settings = { ...defaults, ...loadJson("rgm_settings") };

function loadJson(key) {
	try {
		return JSON.parse(localStorage.getItem(key)) || {};
	} catch (e) {
		return {};
	}
}

function saveSettings() {
	localStorage.setItem("rgm_settings", JSON.stringify(settings));
}

// ---------- message log ----------

let log = [];
try {
	log = JSON.parse(localStorage.getItem("rgm_log")) || [];
} catch (e) { /* fresh log */ }

function persistLog() {
	localStorage.setItem("rgm_log", JSON.stringify(log.slice(-200)));
}

function addMessage(entry) {
	log.push({ ...entry, time: Date.now() });
	persistLog();
	renderMessage(entry);
}

function renderMessage(entry) {
	const div = document.createElement("div");
	div.className = "msg" + (entry.sent ? " sent" : "") + (entry.error ? " error" : "");
	const meta = document.createElement("span");
	meta.className = "meta";
	const lock = entry.keyId && entry.keyId !== "00"
		? ` <span class="lock">\u{1F512}${entry.keyId}</span>` : "";
	meta.innerHTML = `${escapeHtml(entry.who || "")} · ${escapeHtml(entry.kind || "")}${lock}`;
	div.appendChild(meta);
	div.appendChild(document.createTextNode(entry.text || ""));
	$("messages").appendChild(div);
	$("messages").scrollTop = $("messages").scrollHeight;
}

function escapeHtml(s) {
	return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---------- status ----------

let statusResetTimer = null;
let baseStatus = "idle";

function setStatus(text, temporary) {
	$("status").textContent = text;
	if (statusResetTimer)
		clearTimeout(statusResetTimer);
	if (temporary) {
		statusResetTimer = setTimeout(() => { $("status").textContent = baseStatus; }, 8000);
	} else {
		baseStatus = text;
	}
}

// ---------- modem setup ----------

let modem = null;

async function ensureModem() {
	if (modem)
		return modem;
	const wasm = await createRattlegram();
	modem = new Modem(wasm);
	modem.onStatus = (name, st) => {
		switch (name) {
			case "fail": setStatus("preamble failed", true); break;
			case "sync": setStatus(`sync: ${st.callSign} CFO ${st.cfo.toFixed(1)} Hz`, true); break;
			case "nope": setStatus(`unsupported mode ${st.mode} from ${st.callSign}`, true); break;
			case "heap": setStatus("decoder out of memory"); updateListenUI(); break;
			case "decode-failed":
				addMessage({ who: st.callSign, kind: "decoding failed", error: true, text: "" });
				break;
		}
	};
	modem.onPing = (st) => {
		addMessage({ who: st.callSign, kind: "ping", text: "" });
	};
	modem.onMessage = async ({ callSign, payloadBytes, flips }) => {
		const parsed = await Crypto.parsePayload(payloadBytes);
		if (parsed.error) {
			addMessage({ who: callSign, kind: "received", keyId: parsed.keyId, error: true, text: parsed.error });
		} else {
			addMessage({
				who: callSign,
				kind: parsed.legacy ? "received (legacy)" : "received",
				keyId: parsed.keyId,
				text: parsed.text,
			});
		}
		setStatus(`${flips} bits flipped`, true);
	};
	return modem;
}

// ---------- listen toggle ----------

function updateListenUI() {
	const on = modem && modem.listening;
	$("btn-listen").classList.toggle("active", !!on);
	$("spectrogram").hidden = !(on && settings.showSpectrum);
	setStatus(on ? `listening at ${modem.sampleRate} Hz` : "idle");
}

$("btn-listen").addEventListener("click", async () => {
	try {
		const m = await ensureModem();
		if (m.listening) {
			m.stopListening();
			m.onSpectrum = null;
		} else {
			await m.startListening();
			if (settings.showSpectrum)
				attachSpectrum(m);
		}
		updateListenUI();
	} catch (e) {
		setStatus(e.message || "microphone unavailable");
	}
});

function attachSpectrum(m) {
	const canvas = $("spectrogram");
	const ctx2d = canvas.getContext("2d");
	m.onSpectrum = (spectrum, spectrogram) => {
		ctx2d.putImageData(spectrogram, 0, 0);
	};
}

// ---------- compose / send ----------

function maxBytes() {
	return $("key-select").value === "00" ? Crypto.MAX_PLAIN_BYTES : Crypto.MAX_CIPHER_BYTES;
}

function updateCount() {
	const bytes = new TextEncoder().encode($("compose").value).length;
	const max = maxBytes();
	const el = $("char-count");
	el.textContent = `${bytes} / ${max}`;
	el.classList.toggle("over", bytes > max);
	$("btn-send").disabled = bytes > max;
}

$("compose").addEventListener("input", updateCount);
$("key-select").addEventListener("change", updateCount);

$("compose").addEventListener("keydown", (e) => {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		$("btn-send").click();
	}
});

let transmitting = false;

$("btn-send").addEventListener("click", async () => {
	if (transmitting)
		return;
	const text = $("compose").value;
	const keyId = $("key-select").value;
	try {
		const m = await ensureModem();
		const payload = await Crypto.buildPayload(text, keyId);
		transmitting = true;
		$("btn-send").disabled = true;
		setStatus("transmitting…");
		const secs = await m.transmit(payload, settings.callSign, settings);
		setStatus(`sent in ${secs.toFixed(1)} s`, true);
		addMessage({
			who: settings.callSign, sent: true, keyId,
			kind: text ? "transmitted" : "ping",
			text,
		});
		$("compose").value = "";
		updateCount();
	} catch (e) {
		setStatus(e.message || "transmit failed", true);
	} finally {
		transmitting = false;
		$("btn-send").disabled = false;
	}
});

// ---------- key manager ----------

function refreshKeyUI() {
	// compose dropdown
	const sel = $("key-select");
	const current = sel.value;
	sel.innerHTML = "";
	const plain = document.createElement("option");
	plain.value = "00";
	plain.textContent = "\u{1F513} 00";
	sel.appendChild(plain);
	for (const k of Crypto.listKeys()) {
		const o = document.createElement("option");
		o.value = k.id;
		o.textContent = `\u{1F512} ${k.id}`;
		sel.appendChild(o);
	}
	if ([...sel.options].some(o => o.value === current))
		sel.value = current;
	updateCount();

	// manager list
	const ul = $("key-list");
	ul.innerHTML = "";
	const keys = Crypto.listKeys();
	if (!keys.length) {
		const li = document.createElement("li");
		li.innerHTML = `<span class="kdate">No keys yet. Generate one or import.</span>`;
		ul.appendChild(li);
	}
	for (const k of keys) {
		const li = document.createElement("li");
		const date = k.created ? new Date(k.created).toLocaleDateString() : "";
		li.innerHTML = `
			<span class="kid">${k.id}</span>
			<span class="kdate">${date}</span>
			<button class="qr" data-id="${k.id}">QR</button>
			<button class="del" data-id="${k.id}">Delete</button>`;
		ul.appendChild(li);
	}
}

$("btn-keys").addEventListener("click", () => {
	refreshKeyUI();
	$("dlg-keys").showModal();
});

$("btn-gen-key").addEventListener("click", () => {
	try {
		const entry = Crypto.generateKey();
		refreshKeyUI();
		showKeyQr(entry.id);
	} catch (e) {
		alert(e.message);
	}
});

$("key-list").addEventListener("click", (e) => {
	const id = e.target.dataset && e.target.dataset.id;
	if (!id)
		return;
	if (e.target.classList.contains("qr")) {
		showKeyQr(id);
	} else if (e.target.classList.contains("del")) {
		if (confirm(`Delete key ${id}? Messages sent with it can no longer be decrypted.`)) {
			Crypto.deleteKey(id);
			refreshKeyUI();
		}
	}
});

// ---------- QR display + file export ----------

let qrKeyId = null;

function showKeyQr(id) {
	qrKeyId = id;
	$("qr-key-id").textContent = id;
	const data = Crypto.exportKey(id);
	const qr = qrcode(0, "M");
	qr.addData(data);
	qr.make();
	$("qr-holder").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2 });
	$("dlg-qr").showModal();
}

$("btn-export-file").addEventListener("click", () => {
	if (!qrKeyId)
		return;
	const data = Crypto.exportKey(qrKeyId);
	const blob = new Blob([data], { type: "application/json" });
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = `rattlegram-key-${qrKeyId}.json`;
	a.click();
	URL.revokeObjectURL(a.href);
});

// ---------- key import: file ----------

$("btn-import-file").addEventListener("click", () => $("key-file-input").click());

$("key-file-input").addEventListener("change", async (e) => {
	const file = e.target.files[0];
	e.target.value = "";
	if (!file)
		return;
	try {
		const { entry, replaced } = Crypto.parseKeyText(await file.text());
		refreshKeyUI();
		alert(`Key ${entry.id} ${replaced ? "replaced" : "imported"}.`);
	} catch (err) {
		alert(err.message);
	}
});

// ---------- key import: QR scan ----------

let scanStream = null;
let scanRaf = 0;

$("btn-scan-qr").addEventListener("click", async () => {
	const video = $("scan-video");
	try {
		scanStream = await navigator.mediaDevices.getUserMedia({
			video: { facingMode: "environment" },
		});
	} catch (e) {
		alert("Camera unavailable: " + (e.message || e.name));
		return;
	}
	video.srcObject = scanStream;
	await video.play();
	$("scan-status").textContent = "Point the camera at a key QR code.";
	$("dlg-scan").showModal();
	const canvas = document.createElement("canvas");
	const ctx2d = canvas.getContext("2d", { willReadFrequently: true });
	const tick = () => {
		if (!scanStream)
			return;
		if (video.readyState >= video.HAVE_ENOUGH_DATA) {
			canvas.width = video.videoWidth;
			canvas.height = video.videoHeight;
			ctx2d.drawImage(video, 0, 0);
			const img = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
			const code = jsQR(img.data, img.width, img.height);
			if (code && code.data) {
				try {
					const { entry, replaced } = Crypto.parseKeyText(code.data);
					stopScan();
					$("dlg-scan").close();
					refreshKeyUI();
					alert(`Key ${entry.id} ${replaced ? "replaced" : "imported"}.`);
					return;
				} catch (err) {
					$("scan-status").textContent = err.message;
				}
			}
		}
		scanRaf = requestAnimationFrame(tick);
	};
	scanRaf = requestAnimationFrame(tick);
});

function stopScan() {
	cancelAnimationFrame(scanRaf);
	if (scanStream) {
		scanStream.getTracks().forEach(t => t.stop());
		scanStream = null;
	}
	$("scan-video").srcObject = null;
}

$("dlg-scan").addEventListener("close", stopScan);

// ---------- settings dialog ----------

$("btn-settings").addEventListener("click", () => {
	$("set-callsign").value = settings.callSign;
	$("set-carrier").value = settings.carrierFrequency;
	$("set-noise").value = settings.noiseSymbols;
	$("set-fancy").checked = settings.fancyHeader;
	$("set-spectrum").checked = settings.showSpectrum;
	$("dlg-settings").showModal();
});

$("dlg-settings").addEventListener("close", () => {
	settings.callSign = ($("set-callsign").value || "ANONYMOUS")
		.toUpperCase().replace(/[^A-Z0-9 ]/g, "").slice(0, 9) || "ANONYMOUS";
	settings.carrierFrequency = clampInt($("set-carrier").value, 800, 3000, 1500);
	settings.noiseSymbols = clampInt($("set-noise").value, 0, 64, 6);
	settings.fancyHeader = $("set-fancy").checked;
	settings.showSpectrum = $("set-spectrum").checked;
	saveSettings();
	if (modem && modem.listening) {
		if (settings.showSpectrum)
			attachSpectrum(modem);
		else
			modem.onSpectrum = null;
	}
	updateListenUI();
});

function clampInt(v, min, max, dflt) {
	const n = parseInt(v, 10);
	if (isNaN(n))
		return dflt;
	return Math.min(max, Math.max(min, n));
}

// ---------- dialog close buttons ----------

document.querySelectorAll(".dlg-close").forEach(btn => {
	btn.addEventListener("click", () => $(btn.dataset.dlg).close());
});

// ---------- init ----------

for (const entry of log)
	renderMessage(entry);
refreshKeyUI();
updateCount();
setStatus("idle");
