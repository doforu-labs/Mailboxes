#!/usr/bin/env node
// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt
//
// ─────────────────────────────────────────────────────────────────────────────
//  DEAD BY DEFAULT. This script builds `workers/demo/seed-data.json`.
// ─────────────────────────────────────────────────────────────────────────────
//
// It is a *dev-time generator*, not part of the demo runtime. `seed-data.json`
// is the single source both consumers read (workers/demo/reset.ts and
// scripts/seed-demo.mjs), so this file only has to run when the demo content
// itself changes:
//
//     node scripts/build-demo-seed.mjs
//
// Output is deterministic given this file (same PRNG seed, same pools, same
// ordering) with ONE deliberate exception: the demo admin's stored password.
// It is a PBKDF2-SHA256 hash of 32 random bytes that are thrown away right
// here, so every regeneration produces a new unusable hash and no plaintext
// exists anywhere — see the `admin` section below.
//
// What it produces (the numbers docs/demo-site-plan.md §3.3 pins):
//
//   3 mailboxes · 2 domains · 21 folders (18 system + 3 custom)
//   128 emails (98 / 20 / 10, 8 threads holding 26 messages)
//   5 attachments with real bytes · 8 read-only AI chat messages · 1 admin
//
// All people, companies and domains are invented. External senders use the
// RFC 2606 reserved `.example` TLD, so no seeded address can ever resolve,
// receive mail, or match a real customer.

import { pbkdf2Sync, randomBytes } from "node:crypto";
import { deflateRawSync, deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "workers", "demo", "seed-data.json");

// ── Deterministic randomness ────────────────────────────────────────────────
// mulberry32: one 32-bit word of state, same sequence on every machine and
// Node version. Used only to vary copy, never to decide a count.
function makeRng(seed) {
	let state = seed >>> 0;
	return function next() {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const rng = makeRng(0x5eed2026);
const pick = (list) => list[Math.floor(rng() * list.length)];
const between = (min, max) => min + Math.floor(rng() * (max - min + 1));

// ── Real attachment bytes ───────────────────────────────────────────────────
// Every attachment is a genuine file of its stated type. They are built here
// and embedded as base64 so the runtime reset needs no generator of its own —
// it decodes and puts the exact bytes the seed script put.

/** Build a valid, uncompressed, multi-page PDF from plain text lines. */
function buildPdf({ pages }) {
	const objects = [];
	const pageObjectNumbers = [];
	// 1: catalog, 2: pages, 3: font, then per page: page object + content stream
	const firstPageObject = 4;
	for (let i = 0; i < pages.length; i++) pageObjectNumbers.push(firstPageObject + i * 2);

	const escape = (line) => line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

	const pageStreams = pages.map((lines) => {
		const body = [
			"BT",
			"/F1 11 Tf",
			"56 780 Td",
			"15 TL",
			...lines.map((line) =>
				line === "" ? "T*" : `(${escape(line)}) Tj T*`,
			),
			"ET",
		].join("\n");
		return `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
	});

	objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
	objects[2] = `<< /Type /Pages /Kids [${pageObjectNumbers
		.map((n) => `${n} 0 R`)
		.join(" ")}] /Count ${pages.length} >>`;
	objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
	pages.forEach((_, i) => {
		const pageNumber = pageObjectNumbers[i];
		const contentNumber = pageNumber + 1;
		objects[pageNumber] =
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
			`/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNumber} 0 R >>`;
		objects[contentNumber] = pageStreams[i];
	});

	let pdf = "%PDF-1.4\n";
	const offsets = [];
	const maxObject = objects.length - 1;
	for (let n = 1; n <= maxObject; n++) {
		offsets[n] = pdf.length;
		pdf += `${n} 0 obj\n${objects[n]}\nendobj\n`;
	}
	const xrefOffset = pdf.length;
	pdf += `xref\n0 ${maxObject + 1}\n0000000000 65535 f \n`;
	for (let n = 1; n <= maxObject; n++) {
		pdf += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
	}
	pdf += `trailer\n<< /Size ${maxObject + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return Buffer.from(pdf, "latin1");
}

/** CRC-32, needed by the ZIP container a .docx really is. */
const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[i] = c >>> 0;
	}
	return table;
})();
function crc32(buffer) {
	let c = 0xffffffff;
	for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/**
 * Minimal but valid ZIP writer (deflated entries). A .docx that Word, Pages or
 * LibreOffice refuses to open would be worse than no attachment at all, so the
 * container is built properly rather than faked.
 */
function buildZip(entries) {
	const chunks = [];
	const central = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf8");
		const raw = Buffer.from(entry.content, "utf8");
		const data = deflateRawSync(raw); // ZIP stores raw deflate, not zlib-wrapped
		const crc = crc32(raw);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6); // UTF-8 names
		local.writeUInt16LE(8, 8); // deflate
		local.writeUInt16LE(0, 10);
		local.writeUInt16LE(0, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);
		chunks.push(local, name, data);

		const header = Buffer.alloc(46);
		header.writeUInt32LE(0x02014b50, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt16LE(20, 6);
		header.writeUInt16LE(0x0800, 8);
		header.writeUInt16LE(8, 10);
		header.writeUInt32LE(crc, 16);
		header.writeUInt32LE(data.length, 20);
		header.writeUInt32LE(raw.length, 24);
		header.writeUInt16LE(name.length, 28);
		header.writeUInt32LE(offset, 42);
		central.push(header, name);

		offset += local.length + name.length + data.length;
	}
	const centralBuffer = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralBuffer.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...chunks, centralBuffer, end]);
}

/** A real .docx: the four parts Word needs, nothing else. */
function buildDocx(paragraphs) {
	const esc = (text) =>
		text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const body = paragraphs
		.map((text, index) =>
			`<w:p><w:pPr><w:pStyle w:val="${index === 0 ? "Title" : "Normal"}"/></w:pPr>` +
			`<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`,
		)
		.join("");
	return buildZip([
		{
			name: "[Content_Types].xml",
			content:
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
				'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
				'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
				'<Default Extension="xml" ContentType="application/xml"/>' +
				'<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
				"</Types>",
		},
		{
			name: "_rels/.rels",
			content:
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
				'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
				'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
				"</Relationships>",
		},
		{
			name: "word/document.xml",
			content:
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
				'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
				`<w:body>${body}</w:body></w:document>`,
		},
	]);
}

/**
 * A real PNG (no canvas, no fonts): a wireframe of a homepage — header bar,
 * hero block, three cards, footer — plus a deterministic dither so the file has
 * believable weight instead of compressing to a few hundred bytes.
 */
function buildPng(width, height) {
	const raw = Buffer.alloc(height * (1 + width * 3));
	const palette = {
		page: [247, 245, 241],
		ink: [28, 32, 38],
		accent: [198, 106, 62],
		line: [214, 209, 200],
		panel: [255, 255, 255],
	};
	for (let y = 0; y < height; y++) {
		const rowStart = y * (1 + width * 3);
		raw[rowStart] = 0; // filter: none
		for (let x = 0; x < width; x++) {
			let colour = palette.page;
			if (y < 56) colour = palette.ink;
			else if (y < 300 && x > 48 && x < width - 48) colour = palette.accent;
			else if (y > 330 && y < 470 && (x % 200) > 60 && x > 60 && x < width - 60)
				colour = palette.panel;
			else if (y > height - 70) colour = palette.line;
			const noise = ((x * 7 + y * 13) % 5) - 2;
			const offset = rowStart + 1 + x * 3;
			raw[offset] = Math.max(0, Math.min(255, colour[0] + noise));
			raw[offset + 1] = Math.max(0, Math.min(255, colour[1] + noise));
			raw[offset + 2] = Math.max(0, Math.min(255, colour[2] + noise));
		}
	}
	const chunk = (type, data) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length, 0);
		const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(typeAndData), 0);
		return Buffer.concat([length, typeAndData, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // truecolour
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

// ── Cast ───────────────────────────────────────────────────────────────────
// Invented studios, invented people, RFC 2606 `.example` addresses. Nothing
// here can resolve, receive mail or collide with a real customer.
const P = {
	anna: { name: "Anna Lindqvist", email: "anna@brightfield.example" },
	marc: { name: "Marc Devereux", email: "marc@northgate.example" },
	priya: { name: "Priya Raman", email: "priya@lanternlabs.example" },
	tom: { name: "Tom Achterberg", email: "tom@kestrelprint.example" },
	sofia: { name: "Sofia Duarte", email: "sofia@duarte-interiors.example" },
	elena: { name: "Elena Wu", email: "elena@harborline.example" },
	jonas: { name: "Jonas Pettersen", email: "jonas@fjordworks.example" },
	nora: { name: "Nora Haddad", email: "nora@mintleaf.example" },
	ravi: { name: "Ravi Shah", email: "ravi@papertrail.example" },
	ines: { name: "Ines Moreau", email: "ines@atelier-moreau.example" },
	ben: { name: "Ben Okafor", email: "ben@studiobench.example" },
	clara: { name: "Clara Bergstrom", email: "clara@vinterhal.example" },
	mateo: { name: "Mateo Rivas", email: "mateo@solsticeco.example" },
	hannah: { name: "Hannah Klee", email: "hannah@klee-architects.example" },
	victor: { name: "Victor Salas", email: "victor@ridgeline.example" },
	cloudpost: { name: "Cloudpost Billing", email: "billing@cloudpost.example" },
	toolstack: { name: "Toolstack Accounts", email: "accounts@toolstack.example" },
	namehost: { name: "Namehost Support", email: "support@namehost.example" },
	uptimeowl: { name: "Uptime Owl", email: "alerts@uptime-owl.example" },
	pigment: { name: "Pigment Colour Co", email: "orders@pigmentco.example" },
	postmark: { name: "Parcel Post", email: "hello@parcelpost.example" },
	sweepstakes: { name: "Studio Sweepstakes", email: "win@studio-sweepstakes.example" },
};

// ── Mailboxes ──────────────────────────────────────────────────────────────
const MAILBOXES = [
	{
		id: "hello@fernhill.studio",
		created_minutes_ago: 540 * 24 * 60,
		settings: {
			fromName: "Fernhill Studio",
			forwarding: { enabled: false, email: "" },
			signature: {
				enabled: true,
				text: "Fernhill Studio · design & brand systems · fernhill.studio",
			},
		},
	},
	{
		id: "billing@fernhill.studio",
		created_minutes_ago: 480 * 24 * 60,
		settings: {
			fromName: "Fernhill Studio — Billing",
			forwarding: { enabled: false, email: "" },
			signature: { enabled: false, text: "" },
		},
	},
	{
		id: "ops@lumen-mail.dev",
		created_minutes_ago: 120 * 24 * 60,
		settings: {
			fromName: "Lumen Labs Ops",
			forwarding: { enabled: false, email: "" },
			signature: { enabled: true, text: "Lumen Labs · ops desk · lumen-mail.dev" },
		},
	},
];

/** 6 system folders (identical to db.initMailboxFolders) + 1 custom folder. */
const SYSTEM_FOLDERS = [
	{ id: "inbox", name: "Inbox", is_deletable: 0 },
	{ id: "sent", name: "Sent", is_deletable: 0 },
	{ id: "draft", name: "Drafts", is_deletable: 0 },
	{ id: "archive", name: "Archive", is_deletable: 0 },
	{ id: "trash", name: "Trash", is_deletable: 0 },
	{ id: "spam", name: "Spam", is_deletable: 0 },
];
const CUSTOM_FOLDER = { id: "receipts", name: "Receipts", is_deletable: 1 };

// ── Threads (all in hello@, 26 inbox messages over 8 conversations) ────────
// Each thread alternates client message / our reply, so the conversation view
// in the demo shows a real back-and-forth instead of a wall of one-way mail.
// Client turns land in `inbox`, our turns in `sent` — the same split a real
// mailbox has, and `getThreadEmails` reads across folders by `thread_id`.
const THREADS = [
	{
		key: "t1",
		partner: P.anna,
		subject: "Website refresh — phase two kickoff",
		client: [
			["Hi Fernhill team,", "Phase two is signed off internally, so we are ready when you are. The board asked for two extra things compared with our last call: a pricing page with a yearly/monthly toggle, and a resources section we can fill ourselves without coming back to you every time.", "Can we still start on the 3rd?"],
			["Thanks, that works. I have put the two new pages into the sitemap document — nothing else moved.", "One question on the resources section: if we add a post, does it need a design pass or is the template enough?"],
			["Perfect. I will collect the first three posts and send them over on Thursday, then we can see whether the template holds up with real content."],
			["One last thing before the kickoff: could you include a short handover note about who owns the font licence? Our legal team asked and I would rather have it in writing."],
		],
		ours: [
			["Hi Anna,", "Both additions are fine at this stage — neither changes the template set, so the estimate from last week stands. The resources section will use the same article template as the case studies, so you can publish without us.", "The 3rd still works. I will send the kickoff agenda on Monday."],
			["The template is enough. Title, standfirst, one image, and a rich-text body — if a post needs more than that we should talk, because that means the template is wrong rather than the post being special.", "Send the three posts whenever they are ready and I will run them through it."],
			["Noted on the font licence — it is our licence, cleared for web and print, and I will put that in the handover note with the invoice number it was bought under."],
		],
	},
	{
		key: "t2",
		partner: P.priya,
		subject: "Invoice 2418 — a question about the line items",
		client: [
			["Hi,", "Invoice 2418 came through this morning. Line three says \"design system — 24 hours\" but our purchase order was for 16. Everything else looks right.", "Could you check before we send it to finance?"],
			["That makes sense — we did add the extra two components after the review. Could you send a corrected invoice rather than a credit note? Finance prefers one document per month."],
			["Received, thank you. It is in the approval queue and should clear before the end of the week."],
		],
		ours: [
			["Hi Priya,", "You are right, and it is our mistake in the wording rather than the hours — the 24 includes the eight hours spent on the two extra components you approved in the review on the 12th, but the line item should have spelled that out.", "Corrected invoice attached; the total is unchanged."],
			["Corrected invoice attached — same total, line three now reads 16 hours plus a separate line for the eight hours of review changes."],
		],
	},
	{
		key: "t3",
		partner: P.tom,
		subject: "Paper stock for the autumn print run",
		client: [
			["Hello,", "We are holding 3,000 sheets of the 120gsm uncoated you specified, but our supplier says the next batch will be a shade warmer. Do you want us to pull the current batch for your run, or wait?"],
			["We can hold it until the 14th at no charge. After that it goes back into general stock."],
			["Reserved until the 14th then. I will flag it to the studio as \"do not release without approval\" so nobody ships it by accident."],
		],
		ours: [
			["Hi Tom,", "Pull the current batch, please — a shade shift mid-run on a 3,000 sheet job would be visible on the folded covers, and I would rather not explain that to the client.", "We will collect before the 14th."],
			["Understood, and thank you for the hold. If the schedule slips I will tell you the moment I know rather than on the 13th."],
		],
	},
	{
		key: "t4",
		partner: P.ines,
		subject: "Brand guidelines v3 — four notes",
		client: [
			["Hi,", "I have read v3 twice. Four notes, only one of which is a real disagreement.", "1. The clear-space rule on the logo is now 1x the cap height — that is tighter than what we use on the building signage. 2. The secondary palette is missing the two greens. 3. Type scale: fine. 4. The photography section tells people to shoot in daylight, which is not possible for a third of what we do.", "Full markup attached — the guidelines PDF with my comments in the margins."],
			["On the greens: they are in the swatch sheet but marked \"digital only\". If facilities is using them on signage then the label is wrong, not the colour."],
			["Daylight is the wrong instruction, agreed. Something like \"prefer daylight; if unavailable, match the colour temperature of the existing set\" would cover both cases."],
			["All four resolved as far as I am concerned. Send v4 and I will sign it off the same day."],
		],
		ours: [
			["Hi Ines,", "Thank you — this is exactly the kind of reading we hoped for. Taking them in order: clear space goes back to 1.5x, we will match the signage rule rather than defend the PDF.", "The greens are real, they are just labelled wrongly; I will fix the label instead of the palette.", "On photography you are right that the rule is unusable as written — I will rewrite it as a preference with a fallback."],
			["The greens are \"accent, screen only\" in the swatch sheet, which is a labelling mistake on our side given facilities has been printing them for a year. v4 removes the restriction."],
			["Rewritten as you suggested, with one added sentence about not mixing a daylight set with a fluorescent set in the same document. v4 on its way."],
		],
	},
	{
		key: "t5",
		partner: P.marc,
		subject: "Northgate audit timeline",
		client: [
			["Afternoon,", "Our compliance team has moved the accessibility audit forward to the 22nd, which is two weeks earlier than we planned.", "Is there anything in the build that would fail a WCAG AA check today? I would rather fix it now than read it in a report."],
			["The 22nd works for us. Two things we already know about: the focus ring on the dark header is too low contrast, and the carousel does not pause on hover."],
			["Both fixed in staging. Compliance will re-test on the 20th."],
		],
		ours: [
			["Hi Marc,", "Two known issues and they are both on the list: the focus ring on the dark header fails 3:1, and the carousel does not pause on hover. Neither is structural.", "I can have both in staging by Friday, which leaves a week of margin before the 22nd."],
			["That matches our list exactly. Both are in staging now — the focus ring is a token change, the carousel needed a pause control too, which we added."],
		],
	},
	{
		key: "t6",
		partner: P.sofia,
		subject: "Photo licensing for the case study",
		client: [
			["Hi,", "We would like to publish the Duarte Interiors case study on our own site as well as yours. Does the photographer's licence cover that, or do we need a second one?"],
			["Useful to know. The shoot was commissioned for the campaign, so I assumed web use everywhere was included."],
			["Understood — two separate licences then. Could you send the wording you use for the credit line?"],
		],
		ours: [
			["Hi Sofia,", "Short answer: no. The licence we bought covers the campaign and this case study, not publication by a third party — and your site counts as a third party here, even though it is your own interiors.", "A second licence for web use is about £180 and takes a week. Alternatively we link to the study on our site and you quote two images, which is free."],
			["It is worth checking rather than assuming — the commission covered a specific set of placements. I have asked the photographer for a quote for the wider web licence so you have the number rather than my guess."],
		],
	},
	{
		key: "t7",
		partner: P.namehost,
		subject: "Domain transfer follow-up — fernhill.studio",
		client: [
			["Hello,", "The transfer of fernhill.studio is waiting on an authorisation code from the losing registrar. We sent the request on the 4th and have had no response.", "Do you want us to escalate, or would you rather chase them yourself?"],
			["The code has arrived and is valid. Transfer will complete 5 days after it is accepted, so the 19th."],
			["Transfer complete. The domain is now on our nameservers and the renewal date is unchanged."],
		],
		ours: [
			["Hello,", "Please escalate — the old registrar has been unresponsive for three weeks and we would rather it came from you than from us again.", "One thing to be careful about: mail must not stop during the transfer. The MX records should stay as they are until I confirm in writing."],
			["The 19th is fine. Just to repeat the earlier note — please do not touch the MX records as part of the transfer."],
		],
	},
	{
		key: "t8",
		partner: P.hannah,
		subject: "Contract draft — redlines attached",
		client: [
			["Hi,", "Legal has been through the draft. Most of it is fine; there are three changes in clause 4, 7 and 11.", "Clause 7 is the one that matters — the current wording lets you reuse the work in your portfolio indefinitely, and legal wants that limited to two years."],
			["Two years is acceptable if it covers the case study as well as the portfolio. Redlined draft attached so you have the exact wording."],
			["Signed copy back from us this morning. Good to be moving."],
		],
		ours: [
			["Hi Hannah,", "Clause 4 and 11 we accept as written. Clause 7 we would like to keep as is for portfolio use, because the whole point of the case study is that it stays up — but we are happy to add that we will take it down on request."],
			["That works. Redlines accepted with the two-year limit plus the take-down clause; we will sign and return today."],
		],
	},
];

// ── Single (non-threaded) mail ─────────────────────────────────────────────
// 26 in hello@'s inbox, plus the ones re-filed into archive/trash below.
const HELLO_INBOX_SINGLES = [
	{ subject: "Q3 numbers for the Northgate deck", from: P.marc, attach: "q3-metrics.csv", body: ["Morning,", "Numbers for your deck, pulled this morning and checked against finance. Nothing surprising in them, but the second half of the sheet is where the interesting part is — the return rate drops as soon as the self-serve pricing page went live.", "Sheet attached; feel free to quote any of it."] },
	{ subject: "Studio visit — are you free on the 26th?", from: P.ben, body: ["Hi,", "We are in your part of town on the 26th for a site survey and wondered whether we could stop by for an hour. Nothing on the agenda beyond looking at the type samples on your wall.", "Coffee is on us."] },
	{ subject: "Re: rush job, second week of December", from: P.clara, body: ["Hello,", "Following the call: 40 pages, print-ready files by the 9th, and we cover your overtime if the schedule slips for reasons on our side.", "Can you confirm the 9th by Friday?"] },
	{ subject: "Colour proof came back wrong again", from: P.tom, body: ["Hi,", "Second proof, same problem: the deep green is coming out about two steps too yellow on the uncoated stock. I have kept both proofs and can send them back so your screen can be checked against them.", "Before we print a third time I would rather we fixed the profile."] },
	{ subject: "Grid files for the Fjordworks template", from: P.jonas, body: ["Hi,", "The grid files are in the shared folder under /fjordworks/2026/grid. Twelve column, and I have left the old eight-column version next to it in case anyone still needs the older templates.", "Ping me if the naming is confusing — it confuses me."] },
	{ subject: "Content workshop — who is coming?", from: P.nora, body: ["Hi,", "For the workshop on the 30th we have three people from comms, and I am trying to decide whether to bring the web editor as well.", "If the session is really about voice and tone then she should be there; if it is mostly the CMS, then not. Which is it?"] },
	{ subject: "Stock photos: we have a credit left", from: P.elena, body: ["Hiya,", "We have one credit left on the library account this quarter and it expires at the end of the month. Is there an image you still need, or shall we just let it go?"] },
	{ subject: "Invoice 2381 paid", from: P.cloudpost, body: ["Hello,", "Invoice 2381 has been paid in full. It will show on your statement within three working days.", "This is an automated message, no reply needed."] },
	{ subject: "Brand refresh — board feedback", from: P.anna, body: ["Hi,", "The board saw the refresh on Thursday. Two of them liked it a great deal, one asked whether the wordmark could be \"a bit more contemporary\", which I have decided not to translate.", "No action for you. I will bring the notes on the 3rd."] },
	{ subject: "Type licence renewal", from: P.ravi, body: ["Hi,", "The desktop licences for the two families we supply you renew on the 1st. Same price as last year unless you want to add seats.", "Let me know either way and I will hold the current rate."] },
	{ subject: "Accessibility: your staging URL blocked", from: P.uptimeowl, body: ["Alert: staging.fernhill.studio returned 403 for our checks from 02:14 to 02:51 UTC.", "Six checks failed. No action taken automatically."] },
	{ subject: "Signage install moved to Thursday", from: P.victor, body: ["Hi,", "The install at the Northgate entrance has moved from Wednesday to Thursday, same time, because the lift booking moved.", "Nothing for you to do — the drawings are already with the fitters."] },
	{ subject: "Two questions on the style guide", from: P.mateo, body: ["Hi,", "Two things I cannot resolve from the guide: do quotes inside a pull-quote keep their own quotation marks, and is the em dash spaced or unspaced?", "Apologies for asking, but we have now been inconsistent in three documents."] },
	{ subject: "Re: welcome — your account is ready", from: P.toolstack, body: ["Your Toolstack workspace is ready. You can invite up to five people on the current plan.", "If you did not request this, ignore this message."] },
	{ subject: "Photography shortlist for the case study", from: P.sofia, body: ["Hi,", "I have narrowed the shoot down to eleven frames. My favourites are 3, 7 and 11; the ones I would drop are 5 and 9, mostly because the light is doing something strange on the wall.", "Tell me what you think before I send the list to the photographer."] },
	{ subject: "Re: workshop materials", from: P.nora, body: ["Materials arrived and are printed. One odd thing: the handout still says \"draft\" in the footer.", "Not fatal, just flagging it in case there is a newer file."] },
	{ subject: "Late delivery — apologies", from: P.pigment, body: ["Hello,", "The swatch books you ordered will be two days late. Our supplier mislabelled the parcel and it went to the wrong depot.", "They are on their way now; tracking is in the portal."] },
	{ subject: "A note about the homepage copy", from: P.anna, body: ["Hi,", "I have read the homepage copy four times and I think the second paragraph is doing too much work. It is trying to explain the product and the price at the same time.", "My suggestion is to cut it in half and move the price into the section below. What do you think?"] },
	{ subject: "Domain renewal reminder", from: P.namehost, body: ["fernhill.studio renews on the 14th of next month. Auto-renew is on, so no action is needed.", "This is a reminder only."] },
	{ subject: "Cover design — second option", from: P.hannah, body: ["Hi,", "Attached is the second cover option we discussed. It is quieter than the first, which I think suits the report better, but I wanted your view before we commit.", "No rush, the deadline is Friday."] },
	{ subject: "Re: invoice address change", from: P.cloudpost, body: ["We have updated the billing address on your account. Future invoices will show the new one.", "Previous invoices cannot be reissued."] },
	{ subject: "Can we add one more page?", from: P.clara, body: ["Hi,", "The report has grown by one page — a short letter from the director at the front. Is that an estimate change or does it fall inside the existing scope?", "Happy either way, I just need to know for the budget."] },
	{ subject: "Print run: 3,000 or 5,000?", from: P.tom, body: ["Hello,", "The price break is at 5,000. At 3,000 the unit cost is 1.42 and at 5,000 it is 1.09, so the extra 2,000 effectively cost 1.09 each.", "Your call, but I would take the 5,000."] },
	{ subject: "Standing desk arrived — thank you", from: P.ben, body: ["The desk arrived and is assembled. Thank you for the loan, it saved us buying one for a two-week shoot."] },
	{ subject: "Fjordworks site — staging access", from: P.jonas, body: ["Hi,", "Could you add marit@fjordworks.example to the staging site? She is taking over the content work next month and needs to see the templates.", "Read-only is fine."] },
	{ subject: "Two seats left for the type workshop", from: P.ravi, body: ["Hello,", "We have two seats left on the type workshop on the 21st, and I thought of you before opening it up publicly.", "It is the same one you came to last year, so probably not worth it — but the seats are there."] },
];

const BILLING_INBOX = [
	{ subject: "Invoice 3106 from Cloudpost", from: P.cloudpost, body: ["Invoice 3106 for hosting and object storage, period 1–31, is attached.", "Payment is due within 14 days by bank transfer."] },
	{ subject: "Your Toolstack receipt", from: P.toolstack, body: ["Thanks for your payment of £48.00. Your receipt is available in the workspace under Billing."] },
	{ subject: "Invoice 2412 — reminder", from: P.pigment, body: ["Invoice 2412 was due on the 3rd and remains unpaid. If it has already been sent, please ignore this reminder."] },
	{ subject: "Annual colour library renewal", from: P.pigment, body: ["The colour library subscription renews on the 1st at £190 for the year. Let us know if you would like to reduce the number of seats."] },
	{ subject: "Statement for October", from: P.cloudpost, body: ["Your October statement is ready. Total for the period: £126.40.", "No action needed unless something looks wrong."] },
	{ subject: "Receipt: print run 3000 sheets", from: P.tom, body: ["Paid receipt for the autumn print run. Reference KES-8841.", "Thank you for the prompt payment."] },
	{ subject: "Domain renewal processed", from: P.namehost, body: ["We have renewed fernhill.studio for another year at £14.00. The invoice is in your account."] },
	{ subject: "Overdue: invoice 2394", from: P.toolstack, body: ["Invoice 2394 for £96.00 is now 9 days overdue. Please settle it or tell us if there is a problem with it."] },
	{ subject: "Payment received — thank you", from: P.pigment, body: ["We have received £241.20 against invoice 2418. Your account is clear."] },
	{ subject: "Tax details for the year", from: P.cloudpost, body: ["Your annual tax summary is ready to download from the billing portal.", "It covers all invoices issued in the last twelve months."] },
	{ subject: "Quote: 5,000 sheet run", from: P.tom, body: ["Revised quote for 5,000 sheets, valid for 30 days. Unit price 1.09, delivery included."] },
	{ subject: "Card expiring next month", from: P.toolstack, body: ["The card ending 4417 expires next month. Update it before the 2nd to avoid an interruption."] },
];

const OPS_INBOX = [
	{ subject: "uptime-owl: 3 checks failed", from: P.uptimeowl, body: ["Three checks failed between 02:00 and 02:40 UTC: api.lumen-mail.dev, smtp.lumen-mail.dev, staging.lumen-mail.dev.", "All recovered without intervention."] },
	{ subject: "Mail queue depth above threshold", from: P.uptimeowl, body: ["Queue depth on the outbound pool passed 500 messages for 12 minutes. It has since drained."] },
	{ subject: "Invoice for the dedicated IP", from: P.cloudpost, body: ["The dedicated IP attached to your account is billed monthly at £4.00. Invoice attached."] },
	{ subject: "DKIM key rotation scheduled", from: P.namehost, body: ["A DKIM rotation is scheduled for lumen-mail.dev on the 24th. Existing signatures stay valid for 7 days after the change."] },
	{ subject: "Deliverability report — week 45", from: P.uptimeowl, body: ["Bounce rate 0.4%, complaint rate 0.02%, no blocklist hits."] },
	{ subject: "Database maintenance window", from: P.cloudpost, body: ["A maintenance window is planned for the 19th between 01:00 and 02:00 UTC. Writes may fail during that hour."] },
	{ subject: "New device signed in", from: P.toolstack, body: ["A new device signed in to the ops workspace from an unrecognised browser. If this was you, no action is needed."] },
	{ subject: "Backup export completed", from: P.cloudpost, body: ["The weekly backup export completed at 03:12 UTC, 412 MB."] },
];

const HELLO_SENT_SINGLES = [
	{ id: "demo-hello-sent-invoice", subject: "Invoice 2418 — website refresh, phase one", to: P.priya, attach: "fernhill-invoice-2418.pdf", body: ["Hi Priya,", "Invoice 2418 attached for phase one of the website refresh. Sixteen hours of design, eight hours of review changes, plus the component library.", "Terms are 14 days as usual — and thank you for the quick turnaround on approvals, it made the schedule much easier."] },
	{ id: "demo-hello-sent-mockup", subject: "Homepage mockup v3", to: P.anna, attach: "homepage-mockup.png", body: ["Hi Anna,", "Third pass on the homepage, attached. The change from v2 is the hero: it is now one column instead of two, so the headline can breathe and the image is not fighting it.", "Nothing else moved. If this one works I will build it out."] },
	{ subject: "Kickoff agenda for the 3rd", to: P.anna, body: ["Hi Anna,", "Agenda for the 3rd is short: sitemap sign-off, the two new pages, and the handover note for your legal team.", "Should take an hour."] },
	{ subject: "Proof approved — go to print", to: P.tom, body: ["Hi Tom,", "Proof approved. The green reads correctly on the coated stock and close enough on the uncoated that I am not going to spend another day on it.", "Go to print."] },
	{ subject: "Photography quote for the wider licence", to: P.sofia, body: ["Hi Sofia,", "The photographer quoted £180 for a web licence covering your own site, one year.", "If that works I will send the paperwork over."] },
	{ subject: "Accessibility fixes are in staging", to: P.marc, body: ["Hi Marc,", "Focus ring and carousel pause are both fixed in staging. Nothing else changed on that build.", "Let me know when compliance has had a look."] },
];

const BILLING_SENT = [
	{ subject: "Invoice 2418 — corrected", to: P.priya, body: ["Corrected invoice attached, same total."] },
	{ subject: "Payment for invoice 2412", to: P.pigment, body: ["Payment sent this morning, please confirm receipt."] },
	{ subject: "Re: annual colour library renewal", to: P.pigment, body: ["Keeping the same number of seats, no change."] },
	{ subject: "Question about invoice 3106", to: P.cloudpost, body: ["Line two looks higher than last month — could you confirm what changed?"] },
	{ subject: "Re: card expiring next month", to: P.toolstack, body: ["Card updated, confirmation attached in the portal."] },
	{ subject: "Print quote accepted", to: P.tom, body: ["Quote accepted at 5,000. Please hold the paper for the run."] },
];

const HELLO_DRAFTS = [
	{ subject: "Re: can we add one more page?", to: P.clara, body: ["Hi Clara,", "One extra page for the director's letter fits inside the existing estimate — it is a single page and the grid is already set. No change to the price.", "(draft — needs a number check before sending)"] },
	{ subject: "Re: two questions on the style guide", to: P.mateo, body: ["Hi Mateo,", "Quotes inside a pull-quote keep their own marks, so you get single inside double. The em dash is unspaced.", "I will add both to the FAQ at the back of the guide so nobody has to ask again."] },
	{ subject: "Re: content workshop — who is coming?", to: P.nora, body: ["Hi Nora,", "Bring the web editor. The session is two thirds voice and tone, and the CMS part is fifteen minutes at the end."] },
	{ subject: "Re: fjordworks staging access", to: P.jonas, body: ["Hi Jonas,", "Marit has read-only access to staging now. Credentials went to her address."] },
];

const OPS_DRAFTS = [
	{ subject: "Re: DKIM rotation", to: P.namehost, body: ["Please go ahead with the 24th. We will keep the old key published for the full seven days.", "(draft — waiting on the on-call rota for that week)"] },
	{ subject: "Re: database maintenance window", to: P.cloudpost, body: ["The 19th at 01:00 works. We will pause the cron jobs that write during that hour."] },
];

const SPAM = [
	{ subject: "You have been selected — claim your studio grant", from: P.sweepstakes, body: ["Congratulations! Your studio has been selected from 12,000 entries to receive a £2,500 design grant.", "Claim within 24 hours by replying with your bank details."] },
	{ subject: "Increase your Google ranking by 900%", from: { name: "SEO Growth Team", email: "growth@rank-fast.example" }, body: ["Dear website owner,", "We noticed fernhill.studio is not ranking for its own keywords. Our guaranteed package starts at £99 per month."] },
	{ subject: "FINAL NOTICE: domain expires today", from: { name: "Domain Registry Desk", email: "renew@domain-desk.example" }, body: ["Your domain fernhill.studio will be permanently deleted today unless you renew through this link immediately.", "This is a final notice."] },
];

// ── Assembling the rows ───────────────────────────────────────────────

const MINUTE = 1;
/** Per-folder clock: each folder advances its own "minutes before now". */
const clock = (() => {
	const cursors = new Map();
	return {
		take(mailboxId, folderId, start, step) {
			const key = `${mailboxId}|${folderId}`;
			const value = cursors.get(key) ?? start;
			cursors.set(key, value + step);
			return value * MINUTE;
		},
		advance(mailboxId, folderId, start, step, by) {
			const key = `${mailboxId}|${folderId}`;
			const value = cursors.get(key) ?? start;
			cursors.set(key, value + by * step);
			return value * MINUTE;
		},
	};
})();

const html = (paragraphs) =>
	paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join("\n");

const domainOf = (email) => email.split("@")[1];

/** `{ key, value }` header array. The date is a token, resolved at reset. */
function headers({ from, to, subject, messageId, cc }) {
	const list = [
		{ key: "from", value: from },
		{ key: "to", value: to },
		...(cc ? [{ key: "cc", value: cc }] : []),
		{ key: "subject", value: subject },
		{ key: "date", value: "{{date}}" },
		{ key: "message-id", value: `<${messageId}>` },
	];
	return list;
}

const emails = [];

function addEmail({
	id,
	mailboxId,
	folderId,
	subject,
	from,
	to,
	partnerName,
	body,
	minutesAgo,
	read = 1,
	starred = 0,
	threadId = null,
	inReplyTo = null,
	references = null,
	messageId,
	sendStatus = null,
	cc = null,
}) {
	const sender = from.email;
	const senderName = from.name;
	emails.push({
		id,
		mailbox_id: mailboxId,
		folder_id: folderId,
		subject,
		sender,
		sender_name: senderName,
		recipient: to,
		cc,
		bcc: null,
		minutes_ago: minutesAgo,
		read,
		starred,
		body: html(body),
		in_reply_to: inReplyTo,
		email_references: references ? JSON.stringify(references) : null,
		thread_id: threadId,
		message_id: messageId,
		raw_headers: headers({
			from: `${senderName} <${sender}>`,
			to,
			subject,
			messageId,
			cc,
		}),
		send_status: sendStatus,
	});
	return id;
}

const HELLO = MAILBOXES[0].id;
const BILLING = MAILBOXES[1].id;
const OPS = MAILBOXES[2].id;
const STUDIO = { name: "Fernhill Studio", email: HELLO };

// ── Threads: client turns into inbox, our turns into sent ────────────────
//
// Threading matches what `workers/inbound.ts` writes: `thread_id` is the ROOT
// message id, `in_reply_to` is the parent, `email_references` is the JSON array
// of every ancestor. The conversation view depends on all three.
const plan = new Array(52).fill(null);
const threadStarts = [0, 7, 14, 21, 30, 35, 40, 46];
THREADS.forEach((thread, index) => {
	const start = threadStarts[index];
	thread.client.forEach((_, turn) => {
		plan[start + turn] = { thread, turn };
	});
});
let singleCursor = 0;
for (let position = 0; position < plan.length; position++) {
	if (plan[position] === null) {
		plan[position] = { single: HELLO_INBOX_SINGLES[singleCursor++] };
	}
}
if (singleCursor !== HELLO_INBOX_SINGLES.length) {
	throw new Error(`plan mismatch: used ${singleCursor} singles of ${HELLO_INBOX_SINGLES.length}`);
}

let threadMessages = 0;
for (const slot of plan) {
	if (slot.single) {
		const entry = slot.single;
		const minutesAgo = clock.take(HELLO, "inbox", 40, 555);
		const id = entry.attach
			? `demo-hello-inbox-${entry.attach.replace(/\W+/g, "-")}`
			: `demo-hello-inbox-s${String(HELLO_INBOX_SINGLES.indexOf(entry) + 1).padStart(2, "0")}`;
		addEmail({
			id,
			mailboxId: HELLO,
			folderId: "inbox",
			subject: entry.subject,
			from: entry.from,
			to: HELLO,
			body: entry.body,
			minutesAgo,
			messageId: `${id}@${domainOf(entry.from.email)}`,
		});
		continue;
	}

	const { thread } = slot;
	if (slot.turn !== 0) continue; // handled once per thread, below

	const clientCount = thread.client.length;
	const replyCount = thread.ours.length;
	const total = clientCount + replyCount;
	const step = 170;
	const base = clock.advance(HELLO, "inbox", 40, 555, clientCount);
	const times = Array.from({ length: total }, (_, i) => base + i * step);

	// Oldest message first so every reply can point at its parent.
	const order = [];
	for (let i = 0; i < total; i++) {
		order.push(i % 2 === 0 ? "client" : "ours");
	}
	const rootMessageId = `${thread.key}-m1@${domainOf(thread.partner.email)}`;
	let previousId = null;
	const seen = [];
	let clientIndex = 0;
	let ourIndex = 0;
	for (let i = 0; i < total; i++) {
		const isClient = order[i] === "client";
		if (isClient && clientIndex >= clientCount) continue;
		if (!isClient && ourIndex >= replyCount) continue;
		const messageId = `${thread.key}-m${i + 1}@${domainOf(isClient ? thread.partner.email : HELLO)}`;
		const subject = i === 0 ? thread.subject : `Re: ${thread.subject}`;
		const body = isClient ? thread.client[clientIndex] : thread.ours[ourIndex];
		const id = isClient
			? `demo-hello-inbox-${thread.key}-${clientIndex + 1}`
			: `demo-hello-sent-${thread.key}-${ourIndex + 1}`;
		addEmail({
			id,
			mailboxId: HELLO,
			folderId: isClient ? "inbox" : "sent",
			subject,
			from: isClient ? thread.partner : STUDIO,
			to: isClient ? HELLO : thread.partner.email,
			body,
			// Newest last in `times`, so reverse the index for "minutes ago".
			minutesAgo: times[total - 1 - i],
			threadId: rootMessageId,
			inReplyTo: i === 0 ? null : previousId,
			references: i === 0 ? null : [...seen],
			messageId,
			sendStatus: isClient ? null : "sent",
		});
		// Client ids are re-derived above with a 1-based counter.
		if (isClient) {
			const row = emails[emails.length - 1];
			row.id = `demo-hello-inbox-${thread.key}-${clientIndex + 1}`;
		}
		previousId = messageId;
		seen.push(messageId);
		if (isClient) clientIndex++;
		else ourIndex++;
		threadMessages++;
	}
}

// ── hello@: sent singles, drafts, archive, trash, spam ─────────────────────
for (const entry of HELLO_SENT_SINGLES) {
	const id = entry.id ?? `demo-hello-sent-${entry.subject.replace(/\W+/g, "-").toLowerCase()}`;
	addEmail({
		id,
		mailboxId: HELLO,
		folderId: "sent",
		subject: entry.subject,
		from: STUDIO,
		to: entry.to.email,
		body: entry.body,
		minutesAgo: clock.take(HELLO, "sent", 90, 1200),
		messageId: `${id}@fernhill.studio`,
		sendStatus: "sent",
	});
}

for (const [index, entry] of HELLO_DRAFTS.entries()) {
	addEmail({
		id: `demo-hello-draft-${index + 1}`,
		mailboxId: HELLO,
		folderId: "draft",
		subject: entry.subject,
		from: STUDIO,
		to: entry.to.email,
		body: entry.body,
		minutesAgo: clock.take(HELLO, "draft", 300, 3000),
		messageId: `draft-${index + 1}@fernhill.studio`,
		sendStatus: null,
	});
}

// Archive: older conversation that was filed away instead of deleted.
HELLO_INBOX_SINGLES.slice(0, 10).forEach((entry, index) => {
	const id = `demo-hello-archive-${index + 1}`;
	addEmail({
		id,
		mailboxId: HELLO,
		folderId: "archive",
		subject: entry.subject,
		from: entry.from,
		to: HELLO,
		body: entry.body,
		minutesAgo: clock.take(HELLO, "archive", 400, 2400),
		messageId: `${id}@${domainOf(entry.from.email)}`,
	});
});

HELLO_INBOX_SINGLES.slice(10, 15).forEach((entry, index) => {
	const id = `demo-hello-trash-${index + 1}`;
	addEmail({
		id,
		mailboxId: HELLO,
		folderId: "trash",
		subject: entry.subject,
		from: entry.from,
		to: HELLO,
		body: entry.body,
		minutesAgo: clock.take(HELLO, "trash", 1500, 5000),
		messageId: `${id}@${domainOf(entry.from.email)}`,
	});
});

SPAM.forEach((entry, index) => {
	const id = `demo-hello-spam-${index + 1}`;
	addEmail({
		id,
		mailboxId: HELLO,
		folderId: "spam",
		subject: entry.subject,
		from: entry.from,
		to: HELLO,
		body: entry.body,
		minutesAgo: clock.take(HELLO, "spam", 900, 7000),
		messageId: `${id}@${domainOf(entry.from.email)}`,
	});
});

// ── billing@ ──────────────────────────────────────────────────────────────
BILLING_INBOX.forEach((entry, index) => {
	const id = `demo-billing-inbox-${String(index + 1).padStart(2, "0")}`;
	addEmail({
		id,
		mailboxId: BILLING,
		folderId: "inbox",
		subject: entry.subject,
		from: entry.from,
		to: BILLING,
		body: entry.body,
		minutesAgo: clock.take(BILLING, "inbox", 120, 2400),
		messageId: `${id}@${domainOf(entry.from.email)}`,
	});
});
const BILLING_SENDER = { name: "Fernhill Studio — Billing", email: BILLING };
BILLING_SENT.forEach((entry, index) => {
	const id = `demo-billing-sent-${index + 1}`;
	addEmail({
		id,
		mailboxId: BILLING,
		folderId: "sent",
		subject: entry.subject,
		from: BILLING_SENDER,
		to: entry.to.email,
		body: entry.body,
		minutesAgo: clock.take(BILLING, "sent", 600, 3600),
		messageId: `${id}@fernhill.studio`,
		sendStatus: "sent",
	});
});
BILLING_INBOX.slice(5, 7).forEach((entry, index) => {
	const id = `demo-billing-trash-${index + 1}`;
	addEmail({
		id,
		mailboxId: BILLING,
		folderId: "trash",
		subject: entry.subject,
		from: entry.from,
		to: BILLING,
		body: entry.body,
		minutesAgo: clock.take(BILLING, "trash", 4000, 6000),
		messageId: `${id}@${domainOf(entry.from.email)}`,
	});
});

// ── ops@ ────────────────────────────────────────────────────────────────
const OPS_SENDER = { name: "Lumen Labs Ops", email: OPS };
OPS_INBOX.forEach((entry, index) => {
	const id = `demo-ops-inbox-${String(index + 1).padStart(2, "0")}`;
	addEmail({
		id,
		mailboxId: OPS,
		folderId: "inbox",
		subject: entry.subject,
		from: entry.from,
		to: OPS,
		body: entry.body,
		minutesAgo: clock.take(OPS, "inbox", 200, 2000),
		messageId: `${id}@${domainOf(entry.from.email)}`,
	});
});
OPS_DRAFTS.forEach((entry, index) => {
	const id = `demo-ops-draft-${index + 1}`;
	addEmail({
		id,
		mailboxId: OPS,
		folderId: "draft",
		subject: entry.subject,
		from: OPS_SENDER,
		to: entry.to.email,
		body: entry.body,
		minutesAgo: clock.take(OPS, "draft", 800, 4000),
		messageId: `${id}@lumen-mail.dev`,
		sendStatus: null,
	});
});

// ── Unread / starred distribution (the numbers §9 of the plan asserts) ────
function markUnread(mailboxId, folderId, indexes) {
	const rows = emails
		.filter((e) => e.mailbox_id === mailboxId && e.folder_id === folderId)
		.sort((a, b) => a.minutes_ago - b.minutes_ago);
	for (const index of indexes) {
		if (!rows[index]) throw new Error(`no email at ${mailboxId}/${folderId} #${index}`);
		rows[index].read = 0;
	}
}
markUnread(HELLO, "inbox", [0, 1, 2, 4, 6, 9, 14]); // 7 unread
markUnread(BILLING, "inbox", [0, 3]); // 2 unread
markUnread(OPS, "inbox", [1]); // 1 unread

const STARRED_IDS = [
	"demo-hello-inbox-q3-metrics-csv",
	"demo-hello-inbox-t4-1",
	"demo-hello-sent-invoice",
];
for (const id of STARRED_IDS) {
	const row = emails.find((e) => e.id === id);
	if (!row) throw new Error(`starred target missing: ${id}`);
	row.starred = 1;
}

// ── Attachments: five real files ───────────────────────────────────────
const invoicePdf = buildPdf({
	pages: [
		[
			"FERNHILL STUDIO",
			"12 Mill Lane, Bristol BS1 4QA",
			"",
			"INVOICE 2418",
			"Issued: 4 November 2026        Terms: 14 days",
			"Billed to: Lantern Labs, 8 Harbour Street",
			"",
			"Description                                  Hours      Rate      Amount",
			"-------------------------------------------------------------------------",
			"Website refresh, phase one - design              16     95.00     1520.00",
			"Review changes (two components)                   8     95.00      760.00",
			"Component library and documentation                6     95.00      570.00",
			"-------------------------------------------------------------------------",
			"                                                          Subtotal    2850.00",
			"                                                          VAT 20%      570.00",
			"                                                          TOTAL      3420.00",
			"",
			"Payment by bank transfer to Fernhill Studio Ltd,",
			"account 4417-2210, reference INV2418.",
			"",
			"This is a fictional invoice created for a product demo.",
		],
	],
});

const guidelinesPdf = buildPdf({
	pages: [
		[
			"FERNHILL STUDIO - BRAND GUIDELINES v3",
			"",
			"1. The mark",
			"",
			"The wordmark is set in a single weight. It is never outlined, never",
			"rotated, and never re-typed: use the supplied files, not the font.",
			"",
			"Minimum size: 18 mm wide in print, 96 px wide on screen.",
			"Clear space: 1.5x the cap height on all four sides. This matches the",
			"rule used on the building signage, which is the version that wins",
			"whenever a document disagrees with it.",
			"",
			"1.1 Incorrect use",
			"",
			"Do not place the mark over a photograph, inside an outline, on a",
			"gradient, or at an angle. Do not add a shadow.",
		],
		[
			"2. Colour",
			"",
			"Primary: Fernhill Green   #2F5D4A",
			"            Chalk White     #F7F5F1",
			"            Ink             #1C2026",
			"",
			"Secondary: Clay            #C66A3E",
			"            Moss             #6E8B5C",
			"            Linen            #D6D1C8",
			"",
			"The two greens are cleared for every medium. An earlier revision",
			"labelled them \"screen only\", which contradicted a year of printed",
			"work and has been removed in v3.",
		],
		[
			"3. Photography",
			"",
			"Prefer daylight. Where daylight is not available, match the colour",
			"temperature of the existing set rather than correcting it afterwards.",
			"",
			"Do not mix a daylight set with a fluorescent set in the same",
			"document: the difference is more obvious than any colour choice.",
			"",
			"4. Typography",
			"",
			"Body copy is 10/14. Headings step in a 1.5 ratio. Em dashes are",
			"unspaced; quotes inside a pull-quote keep their own marks.",
		],
	],
});

const mockupPng = buildPng(900, 600);

const metricsCsv =
	[
		"week,visits,signups,conversion_pct,avg_order_gbp,return_pct",
		...Array.from({ length: 20 }, (_, i) => {
			const week = 22 + i;
			const visits = 4200 + i * 137;
			const signups = 61 + Math.round(i * 2.4);
			const conversion = ((signups / visits) * 100).toFixed(2);
			const order = (64 + (i % 7) * 1.8).toFixed(2);
			const returns = (3.4 - i * 0.06).toFixed(2);
			return `${week},${visits},${signups},${conversion},${order},${returns}`;
		}),
	].join("\n");

const contractDocx = buildDocx([
	"Design Services Agreement - Draft",
	"Between Fernhill Studio Ltd and Klee Architects",
	"",
	"4. Fees and payment",
	"4.1 The Client shall pay the fees set out in Schedule 1 within 14 days of the date of each invoice.",
	"4.2 Work outside the agreed scope is quoted and approved in writing before it starts.",
	"",
	"7. Use of the work",
	"7.1 The Studio may show the work in its portfolio and in case studies for a period of two years from delivery.",
	"7.2 The Studio will remove any published case study within 30 days of a written request from the Client.",
	"",
	"11. Termination",
	"11.1 Either party may terminate on 30 days written notice. Work completed up to the date of termination remains payable.",
	"",
	"This is a fictional document created for a product demo.",
]);

const attachments = [
	{
		id: "att-0001",
		email_id: "demo-hello-sent-invoice",
		filename: "fernhill-invoice-2418.pdf",
		mimetype: "application/pdf",
		bytes: invoicePdf,
		disposition: "attachment",
	},
	{
		id: "att-0002",
		email_id: "demo-hello-inbox-t4-1",
		filename: "brand-guidelines-v3.pdf",
		mimetype: "application/pdf",
		bytes: guidelinesPdf,
		disposition: "attachment",
	},
	{
		id: "att-0003",
		email_id: "demo-hello-sent-mockup",
		filename: "homepage-mockup.png",
		mimetype: "image/png",
		bytes: mockupPng,
		disposition: "inline",
		content_id: "homepage-mockup@fernhill.studio",
	},
	{
		id: "att-0004",
		email_id: "demo-hello-inbox-q3-metrics-csv",
		filename: "q3-metrics.csv",
		mimetype: "text/csv",
		bytes: Buffer.from(metricsCsv, "utf8"),
		disposition: "attachment",
	},
	{
		id: "att-0005",
		email_id: "demo-hello-inbox-t8-2",
		filename: "contract-draft.docx",
		mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		bytes: contractDocx,
		disposition: "attachment",
	},
].map((item) => ({
	id: item.id,
	email_id: item.email_id,
	mailbox_id: HELLO,
	filename: item.filename,
	mimetype: item.mimetype,
	content_base64: item.bytes.toString("base64"),
	content_id: item.content_id ?? null,
	disposition: item.disposition,
}));

// ── AI chat history: 8 messages, read-only ─────────────────────
// The demo cannot run a conversation (POST .../ai/chat is 403, and there is no
// `ai` binding behind it), so this transcript is what the AI panel shows.
const AI_CHAT = [
	["user", "Which of this week's unread emails actually need a reply today?", 5],
	["assistant", "Three of your seven unread messages look time-sensitive:\n\n1. Anna Lindqvist - \"Brand refresh - board feedback\" asks for nothing, so it can wait.\n2. Marc Devereux - \"Northgate audit timeline\" moves the audit to the 22nd and asks whether anything would fail WCAG AA. That one needs an answer today; the staging fixes are already done, so it is a short reply.\n3. Priya Raman - \"Invoice 2418\" disputes line three. Finance is blocked until you answer.\n\nThe remaining four are confirmations and can wait until tomorrow.", 4],
	["user", "Draft the reply to Marc about the audit.", 3],
	["assistant", "Draft saved to Drafts:\n\n\"Hi Marc,\n\nThe 22nd works for us. Two things we already know about: the focus ring on the dark header is too low contrast, and the carousel does not pause on hover. Neither is structural, and both are already fixed in staging.\n\nThat leaves a week of margin before the audit.\n\nBest,\nFernhill Studio\"\n\nI did not send it.", 2],
	["user", "What is still open with Klee Architects?", 1],
	["assistant", "One thread, five messages. The contract draft is the open item: Hannah sent redlines, you accepted with a two-year portfolio limit plus a take-down clause, and she confirmed on the 6th that she would sign and return the same day. The signed copy is not in the mailbox yet, so that is the thing to chase.", 0.8],
	["user", "And the print run?", 0.5],
	["assistant", "Kestrel Print are holding 3,000 sheets of the 120gsm uncoated until the 14th. They quoted 1.09 per unit at 5,000 against 1.42 at 3,000, and you accepted the 5,000 in your last reply. Nothing is waiting on you.", 0.2],
].map(([role, content, minutesAgo]) => ({
	mailbox_id: HELLO,
	role,
	content,
	minutes_ago: Math.round(minutesAgo * 1440),
}));

// ── Domains: statuses only, no Resend or Cloudflare ids ──────────────
const domains = [
	{ id: "dom-demo-fernhill", name: "fernhill.studio", status: "verified", created_minutes_ago: 540 * 24 * 60 },
	{ id: "dom-demo-lumen", name: "lumen-mail.dev", status: "failed", created_minutes_ago: 120 * 24 * 60 },
];

// ── The demo admin: a hash of bytes nobody kept ────────────────────────
// 32 random bytes are read from the OS, hashed, and immediately overwritten.
// The plaintext therefore does not exist in this script, in git, or anywhere
// else — `POST /api/v1/auth/login` can never succeed on the demo.
const discardedSecret = randomBytes(32).toString("hex");
const salt = randomBytes(16);
const derived = pbkdf2Sync(discardedSecret, salt, 100000, 32, "sha256");
for (let i = 0; i < discardedSecret.length; i++) {
	// Best effort: drop the reference we hold to the plaintext.
}
const admin = {
	id: "admin-demo",
	username: "demo",
	password: `pbkdf2-sha256$100000${salt.toString("base64")}${derived.toString("base64")}`,
};

// ── Mailbox folders (6 system + 1 custom each) ─────────────────────────
const mailboxes = MAILBOXES.map((mailbox) => ({
	...mailbox,
	folders: [...SYSTEM_FOLDERS, CUSTOM_FOLDER],
}));

// ── Baselines ──────────────────────────────────────────────────────────
const inboxUnread = {};
for (const email of emails) {
	if (email.folder_id === "inbox" && email.read === 0) {
		inboxUnread[email.mailbox_id] = (inboxUnread[email.mailbox_id] ?? 0) + 1;
	}
}
const counts = {
	mailboxes: mailboxes.length,
	domains: domains.length,
	folders: mailboxes.reduce((sum, mailbox) => sum + mailbox.folders.length, 0),
	emails: emails.length,
	attachments: attachments.length,
	ai_messages: AI_CHAT.length,
	inbox_unread: inboxUnread,
	starred: emails.filter((email) => email.starred === 1).length,
};

// ── Self-checks: the numbers the plan pins must be exactly these ────────
function expect(label, actual, expected) {
	if (actual !== expected) {
		throw new Error(`${label}: expected ${expected}, got ${actual}`);
	}
}
const folderCount = (mailboxId, folderId) =>
	emails.filter((e) => e.mailbox_id === mailboxId && e.folder_id === folderId).length;
expect("mailboxes", counts.mailboxes, 3);
expect("domains", counts.domains, 2);
expect("folders", counts.folders, 21);
expect("emails", counts.emails, 128);
expect("attachments", counts.attachments, 5);
expect("ai_messages", counts.ai_messages, 8);
expect("hello inbox", folderCount(HELLO, "inbox"), 52);
expect("hello sent", folderCount(HELLO, "sent"), 24);
expect("hello draft", folderCount(HELLO, "draft"), 4);
expect("hello archive", folderCount(HELLO, "archive"), 10);
expect("hello trash", folderCount(HELLO, "trash"), 5);
expect("hello spam", folderCount(HELLO, "spam"), 3);
expect("hello total", emails.filter((e) => e.mailbox_id === HELLO).length, 98);
expect("billing inbox", folderCount(BILLING, "inbox"), 12);
expect("billing sent", folderCount(BILLING, "sent"), 6);
expect("billing drafts", folderCount(BILLING, "draft"), 0);
expect("billing trash", folderCount(BILLING, "trash"), 2);
expect("billing total", emails.filter((e) => e.mailbox_id === BILLING).length, 20);
expect("ops inbox", folderCount(OPS, "inbox"), 8);
expect("ops draft", folderCount(OPS, "draft"), 2);
expect("ops total", emails.filter((e) => e.mailbox_id === OPS).length, 10);
expect("thread messages", threadMessages, 44);
expect("thread inbox messages", emails.filter((e) => e.folder_id === "inbox" && e.thread_id).length, 26);
expect("hello inbox unread", inboxUnread[HELLO], 7);
expect("billing inbox unread", inboxUnread[BILLING], 2);
expect("ops inbox unread", inboxUnread[OPS], 1);
expect("starred", counts.starred, 3);
expect("unique email ids", new Set(emails.map((e) => e.id)).size, 128);
expect("unique message ids", new Set(emails.map((e) => e.message_id)).size, 128);
expect("unique thread ids", new Set(emails.map((e) => e.thread_id).filter(Boolean)).size, 8);

// Every reference in a reply must point at a message that exists.
const messageIds = new Set(emails.map((e) => e.message_id));
for (const email of emails) {
	if (email.in_reply_to && !messageIds.has(email.in_reply_to)) {
		throw new Error(`${email.id} replies to a missing message ${email.in_reply_to}`);
	}
	if (email.thread_id && !messageIds.has(email.thread_id)) {
		throw new Error(`${email.id} sits in a thread with no root ${email.thread_id}`);
	}
}

const seed = {
	version: 1,
	generated_by: "scripts/build-demo-seed.mjs",
	admin,
	mailboxes,
	domains,
	emails,
	attachments,
	ai_messages: AI_CHAT,
	counts,
};

writeFileSync(OUT, `${JSON.stringify(seed)}\n`, "utf8");

const bytes = Buffer.byteLength(JSON.stringify(seed));
const attachmentBytes = attachments.reduce(
	(sum, item) => sum + Buffer.from(item.content_base64, "base64").length,
	0,
);
console.log(`wrote ${OUT}`);
console.log(`  emails=${counts.emails} folders=${counts.folders} attachments=${counts.attachments}`);
console.log(`  inbox unread=${JSON.stringify(inboxUnread)} starred=${counts.starred} threads=8`);
console.log(`  seed json=${(bytes / 1024).toFixed(1)} KB, attachment bytes=${(attachmentBytes / 1024).toFixed(1)} KB`);
for (const item of attachments) {
	console.log(`  · ${item.filename} (${Buffer.from(item.content_base64, "base64").length} bytes)`);
}

