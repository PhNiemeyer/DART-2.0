-- Betroffenenrechte: Fristen nach deutschem Kalendertag statt UTC (CURRENT_DATE hängt von der Zeitzone der Datenbank ab).
ALTER TABLE data_subject_request ALTER COLUMN received_at SET DEFAULT (now() AT TIME ZONE 'Europe/Berlin')::date;

CREATE OR REPLACE FUNCTION dsr_overview() RETURNS TABLE (center_code text, center_name text, kind text, offen integer, ueberfaellig integer, erledigt integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.code, c.name, d.kind,
         count(*) FILTER (WHERE d.status IN ('offen','in_bearbeitung'))::int,
         count(*) FILTER (WHERE d.status IN ('offen','in_bearbeitung') AND COALESCE(d.extended_due_date, d.due_date) < (now() AT TIME ZONE 'Europe/Berlin')::date)::int,
         count(*) FILTER (WHERE d.status IN ('erledigt','abgelehnt'))::int
    FROM data_subject_request d JOIN center c ON c.id = d.center_id
   GROUP BY c.code, c.name, d.kind ORDER BY c.code, d.kind
$$;
