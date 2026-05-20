import { neon } from "@netlify/neon";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

const TOTAL_SCORE = `ROUND((
  COALESCE(q1_checkin_process_score,0) + COALESCE(q2_wait_time_score,0) +
  COALESCE(q3_front_desk_score,0) + COALESCE(q4_comfort_cleanliness_score,0) +
  COALESCE(q5_provider_listening_score,0) + COALESCE(q6_explanation_clarity_score,0) +
  COALESCE(q7_professionalism_score,0) + COALESCE(q8_nursing_care_score,0) +
  COALESCE(q9_overall_rating_score,0)) / 9.0, 2)`;

async function migrate(sql) {
  await sql(`
    CREATE TABLE IF NOT EXISTS survey_responses (
      id                           SERIAL PRIMARY KEY,
      submission_id                TEXT,
      submitted_at                 TIMESTAMPTZ,
      q1_checkin_process_label     TEXT,
      q1_checkin_process_score     NUMERIC(6,2),
      q2_wait_time_label           TEXT,
      q2_wait_time_score           NUMERIC(6,2),
      q3_front_desk_label          TEXT,
      q3_front_desk_score          NUMERIC(6,2),
      q4_comfort_cleanliness_label TEXT,
      q4_comfort_cleanliness_score NUMERIC(6,2),
      q5_provider_listening_label  TEXT,
      q5_provider_listening_score  NUMERIC(6,2),
      q6_explanation_clarity_label TEXT,
      q6_explanation_clarity_score NUMERIC(6,2),
      q7_professionalism_label     TEXT,
      q7_professionalism_score     NUMERIC(6,2),
      q8_nursing_care_label        TEXT,
      q8_nursing_care_score        NUMERIC(6,2),
      q9_overall_rating_label      TEXT,
      q9_overall_rating_score      NUMERIC(6,2),
      q10_comments                 TEXT,
      visit_number                 TEXT,
      dateofservice                DATE,
      chartnumber                  TEXT,
      patientlastname              TEXT,
      patientfirstname             TEXT,
      providerprofile              TEXT,
      primarydxicd10               TEXT,
      facilityname                 TEXT,
      date_of_service              DATE,
      visittype                    TEXT,
      facilitynamenew              TEXT,
      imported_at                  TIMESTAMPTZ DEFAULT NOW()
    )
  `, []);
  await sql(`CREATE INDEX IF NOT EXISTS idx_sr_facility   ON survey_responses(facilitynamenew)`, []);
  await sql(`CREATE INDEX IF NOT EXISTS idx_sr_provider   ON survey_responses(providerprofile)`, []);
  await sql(`CREATE INDEX IF NOT EXISTS idx_sr_visittype  ON survey_responses(visittype)`, []);
  await sql(`CREATE INDEX IF NOT EXISTS idx_sr_date       ON survey_responses(date_of_service)`, []);
}

function buildWhere(params) {
  const conds = [];
  const vals = [];
  const p = (v) => { vals.push(v); return `$${vals.length}`; };

  const facility  = params.get("facility");
  const provider  = params.get("provider");
  const visittype = params.get("visittype");
  const dateStart = params.get("dateStart");
  const dateEnd   = params.get("dateEnd");
  const search    = params.get("search");

  if (facility)  conds.push(`facilitynamenew = ${p(facility)}`);
  if (provider)  conds.push(`providerprofile = ${p(provider)}`);
  if (visittype) conds.push(`visittype = ${p(visittype)}`);
  if (dateStart) conds.push(`date_of_service >= ${p(dateStart)}`);
  if (dateEnd)   conds.push(`date_of_service <= ${p(dateEnd)}`);
  if (search) {
    const ph = p(`%${search}%`);
    conds.push(`(patientlastname ILIKE ${ph} OR patientfirstname ILIKE ${ph} OR chartnumber ILIKE ${ph} OR submission_id ILIKE ${ph})`);
  }

  return { where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", vals };
}

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function dateVal(v) {
  if (!v || String(v).trim() === "") return null;
  const s = String(v).trim();
  // M/D/YYYY or MM/DD/YYYY → YYYY-MM-DD
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2,"0")}-${mdy[2].padStart(2,"0")}`;
  // Already ISO-like (YYYY-MM-DD...)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
  return null;
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const sql = neon(process.env.DATABASE_URL);
  await migrate(sql);

  const url = new URL(req.url);
  const params = url.searchParams;

  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === "GET") {
    if (params.get("meta") === "filters") {
      const [fac, prov, vt] = await Promise.all([
        sql(`SELECT DISTINCT facilitynamenew v FROM survey_responses WHERE facilitynamenew IS NOT NULL AND facilitynamenew <> '' ORDER BY 1`, []),
        sql(`SELECT DISTINCT providerprofile  v FROM survey_responses WHERE providerprofile  IS NOT NULL AND providerprofile  <> '' ORDER BY 1`, []),
        sql(`SELECT DISTINCT visittype        v FROM survey_responses WHERE visittype        IS NOT NULL AND visittype        <> '' ORDER BY 1`, []),
      ]);
      return json({ facilities: fac.map(r => r.v), providers: prov.map(r => r.v), visittypes: vt.map(r => r.v) });
    }

    const { where, vals } = buildWhere(params);
    const limit  = Math.min(parseInt(params.get("limit")  || "50"), 500);
    const offset = parseInt(params.get("offset") || "0");

    const [rows, cnt] = await Promise.all([
      sql(
        `SELECT id, submission_id, date_of_service, dateofservice, chartnumber,
                patientlastname, patientfirstname, providerprofile, facilityname,
                facilitynamenew, visittype, primarydxicd10, visit_number,
                q10_comments, imported_at, ${TOTAL_SCORE} AS total_score
         FROM survey_responses ${where}
         ORDER BY date_of_service DESC NULLS LAST, id DESC
         LIMIT ${limit} OFFSET ${offset}`,
        vals
      ),
      sql(`SELECT COUNT(*) AS n FROM survey_responses ${where}`, vals),
    ]);

    return json({ rows, total: parseInt(cnt[0].n), limit, offset });
  }

  // ── POST (bulk import) ───────────────────────────────────────────────────
  if (req.method === "POST") {
    const body = await req.json();
    const records = Array.isArray(body) ? body : [body];
    if (records.length === 0) return json({ inserted: 0, errors: [] });
    if (records.length > 500) return json({ error: "Max 500 records per import" }, 400);

    let inserted = 0;
    const errors = [];

    for (const r of records) {
      try {
        await sql(`
          INSERT INTO survey_responses (
            submission_id, submitted_at,
            q1_checkin_process_label, q1_checkin_process_score,
            q2_wait_time_label, q2_wait_time_score,
            q3_front_desk_label, q3_front_desk_score,
            q4_comfort_cleanliness_label, q4_comfort_cleanliness_score,
            q5_provider_listening_label, q5_provider_listening_score,
            q6_explanation_clarity_label, q6_explanation_clarity_score,
            q7_professionalism_label, q7_professionalism_score,
            q8_nursing_care_label, q8_nursing_care_score,
            q9_overall_rating_label, q9_overall_rating_score,
            q10_comments, visit_number, dateofservice, chartnumber,
            patientlastname, patientfirstname, providerprofile, primarydxicd10,
            facilityname, date_of_service, visittype, facilitynamenew
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
            $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32
          )`,
          [
            r.submission_id   ?? r.SUBMISSION_ID   ?? null,
            dateVal(r.submitted_at ?? r.SUBMITTED_AT),
            r.q1_checkin_process_label     ?? r.Q1_CHECKIN_PROCESS_LABEL     ?? null,
            num(r.q1_checkin_process_score ?? r.Q1_CHECKIN_PROCESS_SCORE),
            r.q2_wait_time_label           ?? r.Q2_WAIT_TIME_LABEL           ?? null,
            num(r.q2_wait_time_score       ?? r.Q2_WAIT_TIME_SCORE),
            r.q3_front_desk_label          ?? r.Q3_FRONT_DESK_LABEL          ?? null,
            num(r.q3_front_desk_score      ?? r.Q3_FRONT_DESK_SCORE),
            r.q4_comfort_cleanliness_label ?? r.Q4_COMFORT_CLEANLINESS_LABEL ?? null,
            num(r.q4_comfort_cleanliness_score ?? r.Q4_COMFORT_CLEANLINESS_SCORE),
            r.q5_provider_listening_label  ?? r.Q5_PROVIDER_LISTENING_LABEL  ?? null,
            num(r.q5_provider_listening_score  ?? r.Q5_PROVIDER_LISTENING_SCORE),
            r.q6_explanation_clarity_label ?? r.Q6_EXPLANATION_CLARITY_LABEL ?? null,
            num(r.q6_explanation_clarity_score ?? r.Q6_EXPLANATION_CLARITY_SCORE),
            r.q7_professionalism_label     ?? r.Q7_PROFESSIONALISM_LABEL     ?? null,
            num(r.q7_professionalism_score ?? r.Q7_PROFESSIONALISM_SCORE),
            r.q8_nursing_care_label        ?? r.Q8_NURSING_CARE_LABEL        ?? null,
            num(r.q8_nursing_care_score    ?? r.Q8_NURSING_CARE_SCORE),
            r.q9_overall_rating_label      ?? r.Q9_OVERALL_RATING_LABEL      ?? null,
            num(r.q9_overall_rating_score  ?? r.Q9_OVERALL_RATING_SCORE),
            r.q10_comments    ?? r.Q10_COMMENTS    ?? null,
            r.visit_number    ?? r.Visit_Number    ?? null,
            dateVal(r.dateofservice),
            r.chartnumber     ?? null,
            r.patientlastname ?? null,
            r.patientfirstname ?? null,
            r.providerprofile ?? null,
            r.primarydxicd10  ?? null,
            r.facilityname    ?? null,
            dateVal(r.date_of_service ?? r.Date_of_Service ?? r.dateofservice),
            r.visittype         ?? null,
            r.facilitynamenew   ?? null,
          ]
        );
        inserted++;
      } catch (err) {
        errors.push({ row: r.submission_id ?? "?", error: err.message });
      }
    }

    return json({ inserted, errors });
  }

  // ── DELETE ───────────────────────────────────────────────────────────────
  if (req.method === "DELETE") {
    const id = parseInt(params.get("id") ?? "");
    if (!id) return json({ error: "Invalid id" }, 400);
    await sql(`DELETE FROM survey_responses WHERE id = $1`, [id]);
    return json({ deleted: true });
  }

  return json({ error: "Method not allowed" }, 405);
}
