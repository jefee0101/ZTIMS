-- ZTIMS: SAMPLE DATA for the officer's Analytics, April 2026.
--
-- NOT part of schema.sql. Run it by hand (Supabase SQL Editor or psql) only
-- when you want the Analytics pages to show figures for April 2026. Every row
-- it adds is marked: submitted_by_email / created_by_email / actor_email /
-- guest email = 'sample-analytics@ztims.local'. analytics-2026-04-sample-remove.sql
-- takes all of it out again.
--
-- What it adds, for April 2026:
--   Places to stay (every private place with a manager):
--     room types (if the place has none), 14 to 18 room requests with a mix of
--     statuses, one submitted and saved monthly report (version 1) per place,
--     the last one left unreported (so coverage shows a missing enterprise).
--   Attractions (every office-run attraction that counts visitors):
--     one confirmed daily count for each date of April, with residence and sex
--     breakdowns, a saved monthly report for the first attraction (finalized),
--     one for the second (submitted), and the third left unreported with its
--     last three dates missing (so coverage shows an incomplete month).
--   Reporting settings for both (the first month of reporting is January 2026).
--
-- Re-runnable: a place that already has an April 2026 report or a sample room
-- request is left alone. Nothing else is touched.

do $$
declare
    marker  constant text := 'sample-analytics@ztims.local';
    yr      constant integer := 2026;
    mo      constant integer := 4;
    days    constant integer := 30;
    codes   text[] := array['ph-filipino','overseas-filipino','ph-foreign','KR','US','JP','CN','AU','GB','DE','CA','TW','SG','FR'];
    -- residence codes other than ph-filipino, with their share of arrivals (percent); ph-filipino takes the rest
    rcodes  text[] := array['overseas-filipino','ph-foreign','KR','US','JP','CN','AU','GB','DE','CA','TW','SG','FR'];
    rshares numeric[] := array[8,3,9,6,5,4,3,3,2,2,2,2,2];
    sp record; n_acc integer; n_att integer; k integer := 0; a integer := 0;
    rt_id text; rate numeric; rooms integer; avail integer; occ integer; gn integer; arr integer;
    occ_rate numeric; v_id text; bid text; j integer; i integer; day integer; nb integer;
    req timestamptz; ci date; nights integer; st text; cc text; dec boolean; m integer;
    tot integer; zam integer; neg integer; oth integer; frn integer; rc boolean; male integer; sx boolean;
    placed integer := 0; nbk integer := 0; ndays integer := 0; at_ts timestamptz;
    d date; s_total integer; s_days integer;
begin
    select count(*) into n_acc from public.spots where type = 'accommodation' and managed_by is not null;
    select count(*) into n_att from public.spots where type = 'spot' and managed_by is null and counts_visitors;

    -- ------------------------------------------------------------ places to stay
    for sp in select s.id from public.spots s where s.type = 'accommodation' and s.managed_by is not null
              order by s.created_at, s.id loop
        k := k + 1;
        if not exists (select 1 from public.accommodation_profiles p where p.spot_id = sp.id) then
            insert into public.accommodation_profiles (spot_id, reporting_from) values (sp.id, date '2026-01-01');
        end if;
        if not exists (select 1 from public.room_types t where t.spot_id = sp.id) then
            insert into public.room_types (spot_id, name, beds, max_guests, base_rate, units)
            values (sp.id, 'Sample Standard Room', 2, 2, 1500 + k * 150, 3 + (k % 3)),
                   (sp.id, 'Sample Family Room', 3, 4, 2400 + k * 120, 2);
        end if;
        select id, base_rate into rt_id, rate from public.room_types where spot_id = sp.id order by base_rate limit 1;
        rooms := (select coalesce(sum(units), 0) from public.room_types where spot_id = sp.id);

        -- room requests made in April (skipped if this place already has sample requests)
        if not exists (select 1 from public.bookings b where b.spot_id = sp.id and b.email = marker) then
            nb := 14 + (k % 5);
            for j in 1..nb loop
                day := 1 + ((j * 7 + k * 3) % 28);
                req := make_timestamptz(yr, mo, day, 9 + (j % 10), (j * 13) % 60, 0, 'Asia/Manila');
                ci := make_date(yr, mo, day) + 3 + ((j * 5) % 30);
                nights := 1 + (j % 4);
                st := (array['completed','completed','confirmed','declined','cancelled','expired','confirmed','no_show','completed','requested'])[1 + (j % 10)];
                dec := st not in ('requested', 'expired');
                cc := codes[1 + ((j * 3 + k) % array_length(codes, 1))];
                insert into public.bookings (code, spot_id, guest_name, email, phone, country_code, adults, children, check_in, check_out,
                    status, total_amount, note, requested_at, expires_at, decided_by_email, decided_at, decline_reason)
                values ('SMP-' || lpad(k::text, 2, '0') || '-' || lpad(j::text, 3, '0'), sp.id, 'Sample Guest ' || j, marker, '', cc,
                    1 + (j % 2), case when j % 3 = 0 then 1 else 0 end, ci, ci + nights, st, rate * nights, '',
                    req, req + interval '24 hours', case when dec then marker else '' end,
                    case when dec then req + interval '5 hours' end,
                    case when st = 'declined' then 'Sample: no rooms free that week' else '' end)
                returning id into bid;
                insert into public.booking_rooms (booking_id, room_type_id, units, rate_per_night) values (bid, rt_id, 1, rate);
                nbk := nbk + 1;
            end loop;
        end if;

        -- the last place to stay is left unreported for April (coverage: missing)
        if k = n_acc then continue; end if;
        if exists (select 1 from public.accommodation_report_versions v where v.spot_id = sp.id and v.year = yr and v.month = mo) then continue; end if;

        occ_rate := least(0.94, 0.60 + (k % 3) * 0.07 + (((hashtext(sp.id || 'apr') % 9) + 9) % 9 - 4) / 100.0);
        avail := rooms * days;
        occ := round(avail * occ_rate);
        gn := round(occ * 2.2);
        arr := greatest(1, round(gn / 2.8));
        at_ts := make_timestamptz(yr, mo + 1, 2, 10, 0, 0, 'Asia/Manila');

        insert into public.accommodation_report_versions
            (spot_id, year, month, version, provenance, rooms, room_nights_available, room_nights_occupied,
             guest_nights, arrivals, source_digest, source_stays, reason, late,
             submitted_by_role, submitted_by_email, submitted_at)
        values (sp.id, yr, mo, 1, 'register', rooms, avail, occ, gn, arr, 'sample-2026-04', 0, '', false,
                'establishment_manager', marker, at_ts)
        returning id into v_id;

        -- arrivals by residence (male + female); the Filipino row takes what the other rows do not
        tot := arr;
        for i in 1..array_length(rcodes, 1) loop
            zam := round(arr * rshares[i] / 100.0 + (((hashtext(v_id || rcodes[i]) % 3) + 3) % 3 - 1));
            zam := greatest(0, least(zam, tot - 1));
            if zam > 0 and exists (select 1 from public.residences r where r.code = rcodes[i]) then
                male := least(zam, round(zam * (0.44 + (((hashtext(rcodes[i] || v_id) % 13) + 13) % 13) / 100.0)));
                insert into public.accommodation_report_version_counts (version_id, residence_code, male, female)
                values (v_id, rcodes[i], male, zam - male);
                tot := tot - zam;
            end if;
        end loop;
        if tot > 0 then
            male := round(tot * 0.47);
            insert into public.accommodation_report_version_counts (version_id, residence_code, male, female)
            values (v_id, 'ph-filipino', male, tot - male);
        end if;

        insert into public.accommodation_period_events (spot_id, year, month, action, version_id, actor_role, actor_email, at)
        values (sp.id, yr, mo, 'submitted', v_id, 'establishment_manager', marker, at_ts);
        -- the first reporting places are finalized; the second-last stays submitted
        if k < n_acc - 1 then
            insert into public.accommodation_periods (spot_id, year, month, finalized_at, finalized_by_email, finalized_version_id)
            values (sp.id, yr, mo, at_ts + interval '3 days', marker, v_id);
            insert into public.accommodation_period_events (spot_id, year, month, action, version_id, actor_role, actor_email, at)
            values (sp.id, yr, mo, 'finalized', v_id, 'admin', marker, at_ts + interval '3 days');
        end if;
        placed := placed + 1;
    end loop;

    -- ------------------------------------------------------------ attractions
    a := 0;
    for sp in select s.id from public.spots s where s.type = 'spot' and s.managed_by is null and s.counts_visitors
              order by s.created_at, s.id loop
        a := a + 1;
        if exists (select 1 from public.attraction_report_versions v where v.spot_id = sp.id and v.year = yr and v.month = mo) then continue; end if;
        if exists (select 1 from public.attraction_daily_counts c where c.spot_id = sp.id and c.count_date = make_date(yr, mo, 1) and c.created_by_email = marker) then continue; end if;
        if not exists (select 1 from public.attraction_settings s where s.spot_id = sp.id) then
            insert into public.attraction_settings (spot_id, reporting_from, attraction_code)
            values (sp.id, date '2026-01-01', 'SMPL-' || lpad(a::text, 2, '0'));
        end if;

        -- one confirmed count per date; the third attraction misses its last three dates
        for d_i in 1..days loop
            d := make_date(yr, mo, d_i);
            if a = 3 and d_i >= days - 2 then continue; end if;
            tot := round((case when extract(isodow from d) in (6, 7) then 120 else 70 end)
                         * (1 + ((a - 1) % 3) * 0.35)
                         * (0.85 + ((hashtext(sp.id || d_i::text) % 31) + 31) % 31 / 100.0));
            rc := d_i % 7 <> 0;                                    -- every seventh day: residence not recorded
            sx := d_i % 5 <> 0;                                    -- every fifth day: sex not recorded
            zam := round(tot * 0.28); neg := round(tot * 0.34); oth := round(tot * 0.26);
            frn := tot - zam - neg - oth;                          -- foreign visitors take the rest
            male := round(tot * 0.52);
            insert into public.attraction_daily_counts
                (spot_id, count_date, total, res_zamboanguita, res_negros_oriental, res_other_province, res_foreign, residence_complete,
                 male, female, sex_complete, created_by_email, updated_by_email, updated_by_role)
            values (sp.id, d, tot,
                    case when rc then zam end, case when rc then neg end, case when rc then oth end, case when rc then frn end, rc,
                    case when sx then male end, case when sx then tot - male end, sx, marker, marker, 'support_staff');
            ndays := ndays + 1;
        end loop;

        -- a saved monthly report for the first and second attraction (the third is left unreported)
        if a <= 2 then
            select count(*), coalesce(sum(total), 0) into s_days, s_total
              from public.attraction_daily_counts c where c.spot_id = sp.id and c.count_date between make_date(yr, mo, 1) and make_date(yr, mo, days);
            insert into public.attraction_report_versions
                (spot_id, year, month, version, dates_counted, zero_days, closed_days, total,
                 res_zamboanguita, res_negros_oriental, res_other_province, res_foreign, res_unrecorded,
                 male, female, sex_unrecorded, daily, source_digest, reason, submitted_by_role, submitted_by_email, submitted_at)
            select sp.id, yr, mo, 1, s_days, 0, 0, s_total,
                   coalesce(sum(c.res_zamboanguita), 0), coalesce(sum(c.res_negros_oriental), 0),
                   coalesce(sum(c.res_other_province), 0), coalesce(sum(c.res_foreign), 0),
                   s_total - coalesce(sum(c.res_zamboanguita), 0) - coalesce(sum(c.res_negros_oriental), 0)
                           - coalesce(sum(c.res_other_province), 0) - coalesce(sum(c.res_foreign), 0),
                   coalesce(sum(c.male), 0), coalesce(sum(c.female), 0),
                   s_total - coalesce(sum(c.male), 0) - coalesce(sum(c.female), 0),
                   coalesce((select jsonb_agg(jsonb_build_object('date', x.count_date, 'total', x.total,
                                 'res', jsonb_build_object('zamboanguita', x.res_zamboanguita, 'negrosOriental', x.res_negros_oriental,
                                                           'otherProvince', x.res_other_province, 'foreign', x.res_foreign),
                                 'male', x.male, 'female', x.female) order by x.count_date)
                             from public.attraction_daily_counts x where x.spot_id = sp.id
                              and x.count_date between make_date(yr, mo, 1) and make_date(yr, mo, days)), '[]'::jsonb),
                   'sample-2026-04', '', 'support_staff', marker, make_timestamptz(yr, mo + 1, 2, 10, 0, 0, 'Asia/Manila')
              from public.attraction_daily_counts c where c.spot_id = sp.id and c.count_date between make_date(yr, mo, 1) and make_date(yr, mo, days)
            returning id into v_id;
            insert into public.attraction_periods (spot_id, year, month, state, current_version_id)
            values (sp.id, yr, mo, 'submitted', v_id);
            insert into public.attraction_period_events (spot_id, year, month, action, version_id, actor_role, actor_email, at)
            values (sp.id, yr, mo, 'submitted', v_id, 'support_staff', marker, make_timestamptz(yr, mo + 1, 2, 10, 0, 0, 'Asia/Manila'));
            if a = 1 then
                update public.attraction_periods set state = 'finalized', finalized_version_id = v_id, updated_at = now()
                 where spot_id = sp.id and year = yr and month = mo;
                insert into public.attraction_period_events (spot_id, year, month, action, version_id, actor_role, actor_email, at)
                values (sp.id, yr, mo, 'finalized', v_id, 'admin', marker, make_timestamptz(yr, mo + 1, 4, 10, 0, 0, 'Asia/Manila'));
            end if;
        end if;
    end loop;

    raise notice 'Analytics April 2026 sample: % places to stay (% reported), % room requests, % attraction day counts.',
        n_acc, placed, nbk, ndays;
end $$;
