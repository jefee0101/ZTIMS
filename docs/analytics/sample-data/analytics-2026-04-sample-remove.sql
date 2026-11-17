-- Removes what analytics-2026-04-sample.sql added (rows marked 'sample-analytics@ztims.local').
-- Saved reports and daily counts are locked on purpose, so this switches the
-- guarding triggers off inside one transaction and back on again. It never
-- touches a row without the marker. Room types made by the sample are removed
-- only when no real booking uses them.
begin;
alter table public.accommodation_period_events          disable trigger user;
alter table public.accommodation_report_version_counts  disable trigger user;
alter table public.accommodation_report_versions        disable trigger user;
alter table public.accommodation_periods                disable trigger user;
alter table public.attraction_period_events             disable trigger user;
alter table public.attraction_periods                   disable trigger user;
alter table public.attraction_report_versions           disable trigger user;
alter table public.attraction_daily_counts              disable trigger user;
alter table public.bookings                             disable trigger user;
alter table public.booking_rooms                        disable trigger user;

-- room requests
delete from public.booking_rooms where booking_id in (select id from public.bookings where email = 'sample-analytics@ztims.local');
delete from public.bookings where email = 'sample-analytics@ztims.local';
delete from public.room_types t where t.name in ('Sample Standard Room', 'Sample Family Room')
  and not exists (select 1 from public.booking_rooms r where r.room_type_id = t.id);

-- places to stay
delete from public.accommodation_period_events where actor_email = 'sample-analytics@ztims.local';
delete from public.accommodation_periods where finalized_by_email = 'sample-analytics@ztims.local';
delete from public.accommodation_report_version_counts
 where version_id in (select id from public.accommodation_report_versions where submitted_by_email = 'sample-analytics@ztims.local');
delete from public.accommodation_report_versions where submitted_by_email = 'sample-analytics@ztims.local';

-- attractions
delete from public.attraction_period_events where actor_email = 'sample-analytics@ztims.local';
delete from public.attraction_periods where current_version_id in
  (select id from public.attraction_report_versions where submitted_by_email = 'sample-analytics@ztims.local');
delete from public.attraction_report_versions where submitted_by_email = 'sample-analytics@ztims.local';
delete from public.attraction_daily_counts where created_by_email = 'sample-analytics@ztims.local';
delete from public.attraction_settings where attraction_code like 'SMPL-%';

alter table public.accommodation_period_events          enable trigger user;
alter table public.accommodation_report_version_counts  enable trigger user;
alter table public.accommodation_report_versions        enable trigger user;
alter table public.accommodation_periods                enable trigger user;
alter table public.attraction_period_events             enable trigger user;
alter table public.attraction_periods                   enable trigger user;
alter table public.attraction_report_versions           enable trigger user;
alter table public.attraction_daily_counts              enable trigger user;
alter table public.bookings                             enable trigger user;
alter table public.booking_rooms                        enable trigger user;
commit;
