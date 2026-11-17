-- Removes what form-a-2025-sample.sql added (rows marked 'sample-data@ztims.local').
-- Saved versions are immutable on purpose, so this switches the guarding
-- triggers off inside one transaction and back on again. Run only to take the
-- sample out; it never touches a row without the marker.
begin;
alter table public.accommodation_period_events    disable trigger user;
alter table public.accommodation_report_version_counts disable trigger user;
alter table public.accommodation_report_versions  disable trigger user;
alter table public.accommodation_periods          disable trigger user;

delete from public.accommodation_period_events  where actor_email = 'sample-data@ztims.local';
delete from public.accommodation_periods p
 where p.finalized_version_id in (select id from public.accommodation_report_versions where submitted_by_email = 'sample-data@ztims.local');
delete from public.accommodation_report_version_counts
 where version_id in (select id from public.accommodation_report_versions where submitted_by_email = 'sample-data@ztims.local');
delete from public.accommodation_report_versions where submitted_by_email = 'sample-data@ztims.local';

alter table public.accommodation_period_events    enable trigger user;
alter table public.accommodation_report_version_counts enable trigger user;
alter table public.accommodation_report_versions  enable trigger user;
alter table public.accommodation_periods          enable trigger user;
commit;
