// SME Owner-TAM Evaluator activity log (added 4 October 2026).
//
// Purpose: give the study objective evidence of whether real SME owners
// actually USED the provided templates — used a prefilled one, downloaded
// the blank one, added rows, uploaded a self-filled file back — alongside
// their TAM ratings. Counts and timestamps only: no file names, no cell
// values, no dataset contents are ever stored here.
//
// Consent-first (RA 10173): logEvent() writes nothing unless the account's
// SME-TAM evaluation session has consent_status = 'given' — same rule as
// recordModuleVisit() in services/tamEvaluation.js. It also never throws:
// a logging failure must never break the user's actual action.
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const pool = require('../db/pool');
const { SME_TAM_ROLE, getOrCreateSession } = require('./tamEvaluation');

const EVENT_TYPES = [
  'prefilled_template_used', 'blank_started', 'blank_template_downloaded',
  'sample_template_downloaded', 'row_added', 'upload_completed', 'upload_failed',
];

async function logEvent(user, eventType, fields = {}) {
  try {
    if (!user || user.role !== SME_TAM_ROLE) return false;
    if (!EVENT_TYPES.includes(eventType)) return false;
    const session = await getOrCreateSession(user.id, SME_TAM_ROLE, 'direct');
    if (!session || session.consent_status !== 'given') return false;
    await pool.query(
      `INSERT INTO sme_tam_activity_events
         (account_id, session_id, event_type, category, dataset_origin, row_count, template_match, match_pct, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        user.id, session.id, eventType,
        fields.category || null,
        fields.datasetOrigin === 'prefilled' || fields.datasetOrigin === 'blank' ? fields.datasetOrigin : null,
        Number.isInteger(fields.rowCount) ? fields.rowCount : null,
        typeof fields.templateMatch === 'boolean' ? fields.templateMatch : null,
        Number.isInteger(fields.matchPct) ? fields.matchPct : null,
        fields.detail ? JSON.stringify(fields.detail) : null,
      ]
    );
    return true;
  } catch (err) {
    console.error('[smeTamActivity] could not log', eventType, err.message);
    return false;
  }
}

// ---- header matching -------------------------------------------------
function normCol(s) {
  return String(s || '').replace(/^﻿/, '').trim().toLowerCase().replace(/[\s_\-]+/g, '_');
}

function readHeader(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const rows = parse(buf.slice(0, n).toString('utf-8'), { to_line: 1, relax_column_count: true, bom: true });
    return (rows[0] || []).map(normCol).filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

// Compares an uploaded CSV's header with every template in the manifest.
// Returns { category, matchPct, exact } for the best-matching template, or
// null when nothing overlaps. matchPct = share of that template's columns
// present in the file (extra columns allowed); exact = matchPct is 100.
function matchUploadToTemplate(filePath, manifest, templatesRoot) {
  let header;
  try { header = new Set(readHeader(filePath)); } catch (e) { return null; }
  if (header.size === 0) return null;
  let best = null;
  for (const row of manifest) {
    let tcols;
    try { tcols = readHeader(path.join(templatesRoot, row.template_file)); } catch (e) { continue; }
    if (tcols.length === 0) continue;
    const hit = tcols.filter((c) => header.has(c)).length;
    const pct = Math.round((hit / tcols.length) * 100);
    if (!best || pct > best.matchPct) {
      best = { category: row.sme_business_category, matchPct: pct, exact: pct === 100 };
    }
  }
  return best && best.matchPct > 0 ? best : null;
}

// ---- reporting -------------------------------------------------------
async function getActivityReport() {
  const { rows } = await pool.query(`
    SELECT a.id AS account_id, a.username, a.owner_name, a.business_type, a.business_sector, a.business_size,
           s.consent_status, s.status AS evaluation_status, s.completed_at,
           COALESCE(ev.prefilled_template_used, 0)   AS prefilled_template_used,
           COALESCE(ev.blank_started, 0)             AS blank_started,
           COALESCE(ev.blank_template_downloaded, 0) AS blank_template_downloaded,
           COALESCE(ev.sample_template_downloaded, 0) AS sample_template_downloaded,
           COALESCE(ev.rows_added, 0)                AS rows_added,
           COALESCE(ev.rows_added_prefilled, 0)      AS rows_added_prefilled,
           COALESCE(ev.rows_added_blank, 0)          AS rows_added_blank,
           COALESCE(ev.uploads, 0)                   AS uploads,
           COALESCE(ev.uploads_template_match, 0)    AS uploads_template_match,
           COALESCE(ev.uploads_after_blank, 0)       AS uploads_after_blank,
           COALESCE(ev.upload_rows, 0)               AS upload_rows,
           ev.last_event_at,
           COALESCE(cp.prefilled_copies, 0)          AS prefilled_copies,
           COALESCE(cp.blank_copies, 0)              AS blank_copies,
           COALESCE(cp.blank_rows_now, 0)            AS blank_rows_now,
           COALESCE(fb.columns_confirmed, 0)         AS roles_confirmed,
           COALESCE(fb.corrections, 0)               AS roles_corrected
      FROM sme_accounts a
      JOIN sme_tam_evaluation_sessions s ON s.account_id = a.id
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (WHERE e.event_type = 'prefilled_template_used')::int   AS prefilled_template_used,
          COUNT(*) FILTER (WHERE e.event_type = 'blank_started')::int             AS blank_started,
          COUNT(*) FILTER (WHERE e.event_type = 'blank_template_downloaded')::int AS blank_template_downloaded,
          COUNT(*) FILTER (WHERE e.event_type = 'sample_template_downloaded')::int AS sample_template_downloaded,
          COUNT(*) FILTER (WHERE e.event_type = 'row_added')::int                 AS rows_added,
          COUNT(*) FILTER (WHERE e.event_type = 'row_added' AND e.dataset_origin = 'prefilled')::int AS rows_added_prefilled,
          COUNT(*) FILTER (WHERE e.event_type = 'row_added' AND e.dataset_origin = 'blank')::int     AS rows_added_blank,
          COUNT(*) FILTER (WHERE e.event_type = 'upload_completed')::int          AS uploads,
          COUNT(*) FILTER (WHERE e.event_type = 'upload_completed' AND e.template_match)::int AS uploads_template_match,
          COUNT(*) FILTER (WHERE e.event_type = 'upload_completed' AND e.template_match AND EXISTS (
              SELECT 1 FROM sme_tam_activity_events b
               WHERE b.account_id = e.account_id AND b.event_type = 'blank_template_downloaded'
                 AND b.category = e.category AND b.created_at <= e.created_at))::int     AS uploads_after_blank,
          COALESCE(SUM(e.row_count) FILTER (WHERE e.event_type = 'upload_completed'), 0)::int AS upload_rows,
          MAX(e.created_at) AS last_event_at
        FROM sme_tam_activity_events e WHERE e.account_id = a.id
      ) ev ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) FILTER (WHERE d.dataset_id NOT LIKE 'EVALBLANK\\_%')::int AS prefilled_copies,
               COUNT(*) FILTER (WHERE d.dataset_id LIKE 'EVALBLANK\\_%')::int     AS blank_copies,
               COALESCE(SUM((SELECT COUNT(*) FROM dataset_records r WHERE r.dataset_id = d.id)
                            ) FILTER (WHERE d.dataset_id LIKE 'EVALBLANK\\_%'), 0)::int AS blank_rows_now
          FROM uploaded_datasets d
         WHERE d.account_id = a.id AND (d.dataset_id LIKE 'EVALCOPY\\_%' OR d.dataset_id LIKE 'EVALBLANK\\_%' OR d.dataset_id = 'EVALUATION_DEFAULT')
      ) cp ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS columns_confirmed,
               COUNT(*) FILTER (WHERE f.was_correction)::int AS corrections
          FROM field_role_feedback f
          JOIN uploaded_datasets d2 ON d2.id = f.dataset_id
         WHERE f.account_id = a.id AND d2.dataset_id NOT LIKE 'EVAL%'
      ) fb ON true
     WHERE a.role = $1
     ORDER BY a.id`, [SME_TAM_ROLE]);

  const consenting = rows.filter((r) => r.consent_status === 'given');
  const sum = (k) => consenting.reduce((t, r) => t + Number(r[k] || 0), 0);
  const nWith = (k) => consenting.filter((r) => Number(r[k]) > 0).length;
  const confirmed = sum('roles_confirmed');
  const corrected = sum('roles_corrected');
  const totals = {
    registered: rows.length,
    consenting: consenting.length,
    notConsenting: rows.length - consenting.length,
    usedPrefilled: nWith('prefilled_template_used'),
    startedBlank: nWith('blank_started'),
    downloadedBlank: nWith('blank_template_downloaded'),
    downloadedSample: nWith('sample_template_downloaded'),
    addedRows: nWith('rows_added'),
    rowsAdded: sum('rows_added'),
    uploaded: nWith('uploads'),
    uploadedTemplateMatch: nWith('uploads_template_match'),
    uploadedAfterBlank: nWith('uploads_after_blank'),
    uploadRows: sum('upload_rows'),
    ownersWithRoleFeedback: nWith('roles_confirmed'),
    rolesConfirmed: confirmed,
    rolesCorrected: corrected,
    roleAgreementPct: confirmed > 0 ? Math.round(((confirmed - corrected) / confirmed) * 1000) / 10 : null,
  };
  return { rows, consenting, totals };
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_COLUMNS = [
  ['account_id', 'account_id'], ['username', 'username'], ['business_category', 'business_sector'],
  ['business_size', 'business_size'], ['evaluation_status', 'evaluation_status'],
  ['used_prefilled_template_count', 'prefilled_template_used'], ['started_blank_count', 'blank_started'],
  ['blank_template_downloads', 'blank_template_downloaded'], ['sample_template_downloads', 'sample_template_downloaded'],
  ['rows_added', 'rows_added'], ['rows_added_to_prefilled', 'rows_added_prefilled'], ['rows_added_to_blank', 'rows_added_blank'],
  ['uploads', 'uploads'], ['uploads_matching_template', 'uploads_template_match'],
  ['uploads_matching_after_blank_download', 'uploads_after_blank'], ['uploaded_rows', 'upload_rows'],
  ['prefilled_copies_held', 'prefilled_copies'], ['blank_copies_held', 'blank_copies'], ['rows_now_in_blank_copies', 'blank_rows_now'],
  ['field_roles_confirmed', 'roles_confirmed'], ['field_roles_corrected', 'roles_corrected'],
  ['last_activity_at', 'last_event_at'],
];

// Only consenting respondents are exported (the rest are excluded, as in
// the on-screen totals).
function buildCsv(consentingRows) {
  const lines = [CSV_COLUMNS.map(([h]) => h).join(',')];
  consentingRows.forEach((r) => lines.push(CSV_COLUMNS.map(([, k]) => csvCell(r[k])).join(',')));
  return lines.join('\r\n') + '\r\n';
}

module.exports = { logEvent, matchUploadToTemplate, getActivityReport, buildCsv, EVENT_TYPES };
