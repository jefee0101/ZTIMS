-- Read-only. Run in the Supabase SQL Editor BEFORE the rollout and again AFTER it:
-- every "preserved" line must be identical in both runs. Changes nothing.
select 'preserved: 2025 municipal months' as check, count(*)::text as value from public.monthly_reports where kind = 'municipal_total' and status = 'submitted' and year = 2025
union all select 'preserved: 2025 municipal fingerprint', md5(string_agg(r.id || r.month || coalesce(r.rooms, 0) || coalesce(r.room_nights_occupied, 0) || coalesce(r.guest_nights, 0) || c.residence_code || c.total, ',' order by r.month, c.residence_code))
  from public.monthly_reports r join public.monthly_report_counts c on c.report_id = r.id where r.kind = 'municipal_total'
union all select 'preserved: earlier attraction reports', count(*)::text from public.monthly_reports where kind = 'attraction'
union all select 'preserved: earlier attraction fingerprint', coalesce(md5(string_agg(row(m.*)::text, ',' order by m.id)), 'none') from public.monthly_reports m where m.kind = 'attraction'
union all select 'preserved: their country rows', count(*)::text from public.monthly_report_counts c join public.monthly_reports r on r.id = c.report_id where r.kind = 'attraction'
union all select 'preserved: attraction Guest Register entries', count(*)::text from public.register_entries e join public.spots s on s.id = e.spot_id where s.type = 'spot'
union all select 'preserved: accommodation reports (monthly_reports)', count(*)::text from public.monthly_reports where kind = 'accommodation'
union all select 'preserved: accommodation versions', count(*)::text from public.accommodation_report_versions
union all select 'preserved: Tourism Officer accounts', count(*)::text from public.tourism_officers
union all select 'preserved: enterprise manager accounts', count(*)::text from public.establishment_managers
union all select 'preserved: Support Staff accounts', count(*)::text from public.support_staff
union all select 'preserved: visitor accounts', count(*)::text from public.visitors
union all select 'preserved: listings', count(*)::text from public.spots
union all select 'preserved: closed dates', count(*)::text from public.spot_closed_dates
union all select 'new: attraction tables (0 before, 7 after)', count(*)::text from information_schema.tables where table_schema = 'public' and table_name like 'attraction\_%'
union all select 'new: daily counts (0 at rollout)', coalesce((select count(*)::text from public.attraction_daily_counts), 'n/a')
union all select 'new: RLS on every attraction table', count(*) filter (where relrowsecurity)::text || ' of ' || count(*)::text from pg_class where relkind = 'r' and relname like 'attraction\_%'
order by 1;
-- Records that cannot be safely transformed (nothing is converted; they stay as they are):
--   earlier attraction reports and their country rows: country of residence, with Filipino
--   nationality not split into municipality / province / elsewhere, and no days; cannot become
--   daily counts or the four residence classes without inventing detail.
--   attraction Guest Register entries: groups by date with country and sex; same reason.
select 'cannot transform: earlier attraction reports by year-month' as note, year || '-' || lpad(month::text, 2, '0') as value, count(*) as n
  from public.monthly_reports where kind = 'attraction' group by year, month order by year, month;
-- Who must be assigned before attraction recording starts:
select 'office attractions counting visitors' as note, s.title as value, (select count(*) from public.support_staff ss where ss.spot_id = s.id and ss.status = 'active') as active_support_staff
  from public.spots s where s.type = 'spot' and s.managed_by is null and s.counts_visitors and s.status <> 'archived' order by s.title;
-- Which role the API connects as, and whether it bypasses Row Level Security. Run this through the SAME connection string the API uses
-- (for example from a one-off script with DATABASE_URL), not in the SQL Editor:
select current_user as api_role, r.rolbypassrls, r.rolsuper, (select relowner::regrole::text from pg_class where relname = 'attraction_daily_counts') as table_owner from pg_roles r where r.rolname = current_user;
