-- Migration 0010: Persist the From display name so list rows can show
-- "GitHub" instead of "noreply".
--
-- The email list derived its label from the address local-part, so every
-- automated sender (noreply@, no-reply@, bounce@, ...) looked identical.
-- Mail clients like Gmail show the From display name and only fall back to
-- the local-part when the header has no name. We now store the name in its
-- own column and apply the same fallback in the UI.

ALTER TABLE emails ADD COLUMN sender_name TEXT;

-- Backfill existing rows from the raw_headers JSON blob, which preserves the
-- original `From` header, e.g. [{"key":"from","value":"GitHub <noreply@github.com>"}].
--
-- The extraction mirrors parseFromAddress() in workers/inbound.ts so a backfilled
-- row renders like one received today:
--   * the display name is everything before the `<` that opens the address;
--   * a *wrapping* pair of double quotes is removed, so `"Acme Inc" <a@b.com>`
--     yields `Acme Inc` — but an inner quote is part of the name and is kept,
--     so `O"Brien <o@b.com>` does not become `OBrien`;
--   * a value with no `<` at all carries no display name and stays NULL.
--
-- Two guards matter here:
--   * `json_valid(...) AND json_type(...) = 'array'` keeps rows whose blob is
--     NULL, empty or not a JSON array out of the json_* functions.
--   * `h.type = 'object'` (the `type` column exposed by json_each) skips array
--     elements that are scalars. Calling json_extract()/json_type() on a scalar
--     element raises "malformed JSON", which would abort the whole migration.
--     Note json_type(h.value) is NOT a safe guard for this — it throws too.
--
-- Known limitation: the split is taken at the FIRST `<`, whereas the regex in
-- parseFromAddress() is anchored at the end of the string and so effectively
-- splits at the LAST one. The two disagree only for a header whose display name
-- itself contains a `<` (e.g. `Foo <bar> <x@y.com>`), which no real mail client
-- emits. Such a row keeps a best-effort name rather than being nulled, and the
-- 400-char/separator cleanup below still applies to it.
UPDATE emails
SET sender_name = (
  SELECT NULLIF(
           TRIM(
             CASE
               WHEN LENGTH(v) > 1 AND SUBSTR(v, 1, 1) = '"' AND SUBSTR(v, -1, 1) = '"'
                 THEN SUBSTR(v, 2, LENGTH(v) - 2)
               ELSE v
             END
           ),
           ''
         )
  FROM (
    SELECT TRIM(SUBSTR(json_extract(h.value, '$.value'), 1,
                       instr(json_extract(h.value, '$.value'), '<') - 1)) AS v
    FROM json_each(emails.raw_headers) AS h
    WHERE h.type = 'object'
      AND LOWER(TRIM(json_extract(h.value, '$.key'))) = 'from'
      AND instr(json_extract(h.value, '$.value'), '<') > 0
    LIMIT 1
  ) AS extracted
)
WHERE raw_headers IS NOT NULL
  AND json_valid(raw_headers)
  AND json_type(raw_headers) = 'array'
  AND sender_name IS NULL;

-- Normalise what was extracted. Two things happen here, and only two:
--
--   * Names longer than sanitizeSenderName()'s 400-code-point cap are
--     TRUNCATED, not dropped, matching what the write path stores. SQLite's
--     SUBSTR()/LENGTH() count characters (code points), like Array.from().
--   * The RS/US separators (CHAR(30)/CHAR(31)) are replaced with a space. A
--     legacy From header containing one would otherwise break the RS/US framing
--     that getThreadedEmails() builds participants_meta from, splitting a single
--     sender into two participants. (getThreadedEmails() strips them defensively
--     too, but cleaning the stored value is cheap and keeps the column sane.)
--
-- Deliberately NOT done here: dropping a name that merely *looks like* an
-- address ("noreply@github.com", from `"noreply@github.com" <noreply@github.com>`).
-- Doing that would (a) disagree with the live path — parseFromAddress() in
-- workers/inbound.ts keeps such a name — so backfilled and freshly-received mail
-- would render differently, and (b) discard legitimate names that contain an "@",
-- e.g. "Acme @ Home". The fallback to the local-part is applied at render time by
-- formatSenderLabel() in shared/participants.ts, for old and new mail alike.
--
-- NOTE: RFC 2047 encoded-words ("=?utf-8?B?...?=") are stored as-is and decoded at
-- render time by decodeMimeWords(); the 400 cap is generous enough to fit one.
UPDATE emails
SET sender_name = REPLACE(REPLACE(SUBSTR(sender_name, 1, 400), CHAR(30), ' '), CHAR(31), ' ')
WHERE sender_name IS NOT NULL
  AND (
    LENGTH(sender_name) > 400
    OR INSTR(sender_name, CHAR(30)) > 0
    OR INSTR(sender_name, CHAR(31)) > 0
  );
