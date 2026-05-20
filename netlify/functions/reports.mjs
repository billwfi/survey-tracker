import { neon } from "@netlify/neon";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

const TOTAL_SCORE = `(
  COALESCE(q1_checkin_process_score,0) + COALESCE(q2_wait_time_score,0) +
  COALESCE(q3_front_desk_score,0) + COALESCE(q4_comfort_cleanliness_score,0) +
  COALESCE(q5_provider_listening_score,0) + COALESCE(q6_explanation_clarity_score,0) +
  COALESCE(q7_professionalism_score,0) + COALESCE(q8_nursing_care_score,0) +
  COALESCE(q9_overall_rating_score,0)) / 9.0`;

const Q_AVGS = `
  ROUND(AVG(q1_checkin_process_score),2)     AS q1_avg,
  ROUND(AVG(q2_wait_time_score),2)           AS q2_avg,
  ROUND(AVG(q3_front_desk_score),2)          AS q3_avg,
  ROUND(AVG(q4_comfort_cleanliness_score),2) AS q4_avg,
  ROUND(AVG(q5_provider_listening_score),2)  AS q5_avg,
  ROUND(AVG(q6_explanation_clarity_score),2) AS q6_avg,
  ROUND(AVG(q7_professionalism_score),2)     AS q7_avg,
  ROUND(AVG(q8_nursing_care_score),2)        AS q8_avg,
  ROUND(AVG(q9_overall_rating_score),2)      AS q9_avg`;

function buildWhere(params) {
  const conds = [];
  const vals = [];
  const p = (v) => { vals.push(v); return `$${vals.length}`; };

  const facility  = params.get("facility");
  const provider  = params.get("provider");
  const visittype = params.get("visittype");
  const dateStart = params.get("dateStart");
  const dateEnd   = params.get("dateEnd");

  if (facility)  conds.push(`facilitynamenew = ${p(facility)}`);
  if (provider)  conds.push(`providerprofile = ${p(provider)}`);
  if (visittype) conds.push(`visittype = ${p(visittype)}`);
  if (dateStart) conds.push(`date_of_service >= ${p(dateStart)}`);
  if (dateEnd)   conds.push(`date_of_service <= ${p(dateEnd)}`);

  return { where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", vals };
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const sql = neon(process.env.DATABASE_URL);
  const url = new URL(req.url);
  const params = url.searchParams;
  const view = params.get("view") || "summary";
  const { where, vals } = buildWhere(params);

  // ── Summary KPIs ─────────────────────────────────────────────────────────
  if (view === "summary") {
    const rows = await sql(`
      SELECT
        COUNT(*)                                  AS total_responses,
        ROUND(AVG(${TOTAL_SCORE}), 2)             AS avg_total_score,
        COUNT(DISTINCT facilitynamenew)           AS facility_count,
        COUNT(DISTINCT providerprofile)           AS provider_count,
        COUNT(DISTINCT visittype)                 AS visittype_count,
        MIN(date_of_service)                      AS earliest_date,
        MAX(date_of_service)                      AS latest_date,
        ${Q_AVGS}
      FROM survey_responses ${where}
    `, vals);
    return json(rows[0]);
  }

  // ── By Facility ──────────────────────────────────────────────────────────
  if (view === "by-facility") {
    const rows = await sql(`
      SELECT
        COALESCE(facilitynamenew,'(unknown)') AS facility,
        COUNT(*)                              AS responses,
        ROUND(AVG(${TOTAL_SCORE}), 2)        AS avg_total_score,
        ${Q_AVGS}
      FROM survey_responses ${where}
      GROUP BY facilitynamenew
      ORDER BY avg_total_score DESC NULLS LAST
    `, vals);
    return json(rows);
  }

  // ── By Provider ──────────────────────────────────────────────────────────
  if (view === "by-provider") {
    const rows = await sql(`
      SELECT
        COALESCE(providerprofile,'(unknown)')  AS provider,
        COALESCE(facilitynamenew,'(unknown)')  AS facility,
        COUNT(*)                               AS responses,
        ROUND(AVG(${TOTAL_SCORE}), 2)         AS avg_total_score,
        ${Q_AVGS}
      FROM survey_responses ${where}
      GROUP BY providerprofile, facilitynamenew
      ORDER BY avg_total_score DESC NULLS LAST
    `, vals);
    return json(rows);
  }

  // ── By Visit Type ────────────────────────────────────────────────────────
  if (view === "by-visittype") {
    const rows = await sql(`
      SELECT
        COALESCE(visittype,'(unknown)') AS visittype,
        COUNT(*)                        AS responses,
        ROUND(AVG(${TOTAL_SCORE}), 2)  AS avg_total_score,
        ${Q_AVGS}
      FROM survey_responses ${where}
      GROUP BY visittype
      ORDER BY avg_total_score DESC NULLS LAST
    `, vals);
    return json(rows);
  }

  // ── Monthly Trend ────────────────────────────────────────────────────────
  if (view === "trend") {
    const dateFilter = where
      ? `${where} AND date_of_service IS NOT NULL`
      : `WHERE date_of_service IS NOT NULL`;
    const rows = await sql(`
      SELECT
        DATE_TRUNC('month', date_of_service)::DATE AS month,
        COUNT(*)                                    AS responses,
        ROUND(AVG(${TOTAL_SCORE}), 2)              AS avg_total_score
      FROM survey_responses ${dateFilter}
      GROUP BY month
      ORDER BY month
    `, vals);
    return json(rows);
  }

  // ── Score Distribution ───────────────────────────────────────────────────
  if (view === "distribution") {
    const rows = await sql(`
      SELECT
        CASE
          WHEN ${TOTAL_SCORE} >= 4.5 THEN '4.5-5.0'
          WHEN ${TOTAL_SCORE} >= 4.0 THEN '4.0-4.4'
          WHEN ${TOTAL_SCORE} >= 3.0 THEN '3.0-3.9'
          WHEN ${TOTAL_SCORE} >= 2.0 THEN '2.0-2.9'
          ELSE 'Below 2.0'
        END AS bucket,
        COUNT(*) AS responses
      FROM survey_responses ${where}
      GROUP BY bucket
      ORDER BY MIN(${TOTAL_SCORE}) DESC
    `, vals);
    return json(rows);
  }

  return json({ error: "Unknown view" }, 400);
}
