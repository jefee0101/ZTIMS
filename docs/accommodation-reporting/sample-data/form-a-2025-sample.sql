-- ZTIMS: SAMPLE DATA for the officer's FORM A, year 2025.
--
-- NOT part of schema.sql. Run it by hand (Supabase SQL Editor or psql), only
-- when you want FORM A to show figures. Every row is marked
-- submitted_by_email = 'sample-data@ztims.local', so it is never mistaken for
-- a real report, and form-a-2025-sample-remove.sql takes it all out again.
--
-- What it does: for every private place to stay (type 'accommodation' with a
-- manager) it saves one submitted version of each month of 2025, with the
-- country counts (male + female) FORM A reads. January to November are
-- finalized, December is submitted and waits for the officer. The figures are
-- invented: seasonal occupancy (high in Dec-Jan, Apr-May, lower Jun-Sep), a
-- stay of about 2.6 nights, a spread over Filipino, overseas Filipino and
-- foreign residence rows.
--
-- Re-runnable: a place and month that already has any version is left alone.
-- Nothing else is touched: no listings, rooms, stays or 2026 data.
-- If there is no private place to stay, it only says so.

do $$
declare
    sp record; m integer; days integer; v_id text;
    rooms integer; avail integer; occ integer; gnights integer; arr integer;
    occ_rate numeric; season numeric[] := array[0.62, 0.55, 0.58, 0.72, 0.70, 0.50, 0.48, 0.52, 0.45, 0.50, 0.58, 0.78];
    -- code, share of arrivals in percent (the rest goes to ph-filipino)
    codes text[] := array['overseas-filipino','ph-foreign','KR','US','CN','JP','AU','GB','DE','CA','TW','FR','SG'];
    shares numeric[] := array[7, 2, 8, 5, 4, 3, 3, 2, 2, 2, 2, 1, 1];
    i integer; n integer; rest integer; male integer; k integer := 0;
    placed integer := 0; at_ts timestamptz; fin boolean;
    marker constant text := 'sample-data@ztims.local';
begin
    for sp in select s.id from public.spots s
              where s.type = 'accommodation' and s.managed_by is not null
              order by s.created_at, s.id loop
        k := k + 1;
        rooms := 6 + ((k * 5) % 11);                       -- 6 to 16 rooms
        for m in 1..12 loop
            if exists (select 1 from public.accommodation_report_versions v
                       where v.spot_id = sp.id and v.year = 2025 and v.month = m) then
                continue;
            end if;
            days := extract(day from (make_date(2025, m, 1) + interval '1 month - 1 day'))::integer;
            occ_rate := least(0.95, season[m] + (((hashtext(sp.id || m::text) % 11) + 11) % 11 - 5) / 100.0 + (k % 3) * 0.04);
            avail := rooms * days;
            occ := round(avail * occ_rate);
            gnights := round(occ * 2.1);
            arr := greatest(1, round(gnights / 2.6));
            fin := m <= 11;
            at_ts := (make_date(2025, m, 1) + interval '1 month' + interval '2 days 10 hours') at time zone 'Asia/Manila';

            insert into public.accommodation_report_versions
                (spot_id, year, month, version, provenance, rooms, room_nights_available, room_nights_occupied,
                 guest_nights, arrivals, source_digest, source_stays, reason, late,
                 submitted_by_role, submitted_by_email, submitted_at)
            values (sp.id, 2025, m, 1, 'register', rooms, avail, occ, gnights, arr, 'sample-2025', 0, '', false,
                    'establishment_manager', marker, at_ts)
            returning id into v_id;

            -- country counts: fixed shares with a little spread; the rest are Filipino
            rest := arr;
            for i in 1..array_length(codes, 1) loop
                n := round(arr * shares[i] / 100.0 + (((hashtext(v_id || codes[i]) % 3) + 3) % 3 - 1));
                n := greatest(0, least(n, rest - 1));
                if n > 0 and exists (select 1 from public.residences r where r.code = codes[i]) then
                    male := round(n * (0.44 + (((hashtext(codes[i] || v_id) % 13) + 13) % 13) / 100.0));
                    male := least(n, male);
                    insert into public.accommodation_report_version_counts (version_id, residence_code, male, female)
                    values (v_id, codes[i], male, n - male);
                    rest := rest - n;
                end if;
            end loop;
            if rest > 0 then
                male := round(rest * 0.47);
                insert into public.accommodation_report_version_counts (version_id, residence_code, male, female)
                values (v_id, 'ph-filipino', male, rest - male);
            end if;

            insert into public.accommodation_period_events (spot_id, year, month, action, version_id, actor_role, actor_email, at)
            values (sp.id, 2025, m, 'submitted', v_id, 'establishment_manager', marker, at_ts);
            if fin then
                insert into public.accommodation_periods (spot_id, year, month, finalized_at, finalized_by_email, finalized_version_id)
                values (sp.id, 2025, m, at_ts + interval '2 days', marker, v_id)
                on conflict (spot_id, year, month) do update
                    set finalized_at = excluded.finalized_at, finalized_by_email = excluded.finalized_by_email,
                        finalized_version_id = excluded.finalized_version_id;
                insert into public.accommodation_period_events (spot_id, year, month, action, version_id, actor_role, actor_email, at)
                values (sp.id, 2025, m, 'finalized', v_id, 'admin', marker, at_ts + interval '2 days');
            end if;
            placed := placed + 1;
        end loop;
    end loop;
    if k = 0 then
        raise notice 'No private place to stay exists, so nothing was added.';
    else
        raise notice 'FORM A 2025 sample: % places, % months added.', k, placed;
    end if;
end $$;
