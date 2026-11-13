-- ZTIMS database schema, for Supabase (PostgreSQL 15 or later).
--
-- Safe to run more than once: every statement creates only what is missing,
-- so this file is both the first-time setup and the way to bring an existing
-- database up to date. `npm run migrate` runs it; so does pasting it into the
-- Supabase SQL Editor.
--
-- Who can read these tables
-- -------------------------
-- Only the ZTIMS API. It connects as the database owner and enforces every
-- permission itself, in server.js, exactly as it did on MongoDB.
--
-- Supabase also publishes every table through its own REST API to anyone
-- holding the project's public ("anon") key. Row Level Security is switched on
-- for every table below and NO policies are defined, which means that route
-- returns nothing for any table, whoever asks. Do not add policies unless the
-- browser is deliberately meant to read a table directly — nothing in ZTIMS
-- does.
--
-- Ids
-- ---
-- Text, 24 hex characters, the same shape MongoDB's ObjectIds had. The records
-- copied from MongoDB keep their original ids, so links already shared
-- (spot.html?spotId=…) and signed-in sessions (the token carries the account
-- id) keep working across the move. New rows get a random id in the same
-- shape.

create or replace function public.ztims_new_id()
returns text
language sql
volatile
set search_path = ''
as $$
    select left(replace(pg_catalog.gen_random_uuid()::text, '-', ''), 24)
$$;

-- Every table has updated_at; this keeps it honest on every UPDATE, however
-- the row was changed — from the API, a script, or the Supabase table editor.
create or replace function public.ztims_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at = pg_catalog.now();
    return new;
end
$$;


-- ---------------------------------------------------------------------------
-- Tourism Officers: the municipal accounts that oversee everything.
-- Copied from MongoDB's `admins` collection.
-- ---------------------------------------------------------------------------
create table if not exists public.tourism_officers (
    id                  text primary key default public.ztims_new_id(),
    email               text not null unique
                        constraint tourism_officers_email_normalised
                        check (email <> '' and email = lower(btrim(email))),
    password_hash       text not null,
    -- Password reset: only the token's SHA-256 is ever stored.
    reset_token_hash    text,
    reset_token_expires timestamptz,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);


-- ---------------------------------------------------------------------------
-- Tourist Enterprise Managers: the accounts that keep their own listings
-- up to date. Copied from MongoDB's `resortOwners` collection.
-- ---------------------------------------------------------------------------
create table if not exists public.establishment_managers (
    id                  text primary key default public.ztims_new_id(),
    -- The sign-in address. Never shown publicly; contact_email is.
    email               text not null unique
                        constraint establishment_managers_email_normalised
                        check (email <> '' and email = lower(btrim(email))),
    password_hash       text not null,
    establishment_name  text not null
                        constraint establishment_managers_name_required
                        check (btrim(establishment_name) <> ''),
    manager_name        text not null default '',
    contact_email       text not null default '',
    phone               text not null default '',
    -- The office's switch over the account. Suspended accounts cannot sign in
    -- and their listings leave the public site; nothing is deleted.
    active              boolean not null default true,
    -- The enterprise's own statement about whether it is trading.
    operational_status  text not null default 'active'
                        constraint establishment_managers_operational_status
                        check (operational_status in ('active', 'inactive', 'closed')),
    -- Raised when the enterprise reports a change, cleared by the officer.
    status_needs_review boolean not null default false,
    status_note         text not null default '',
    status_updated_at   timestamptz,
    reset_token_hash    text,
    reset_token_expires timestamptz,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists establishment_managers_operational_status_idx
    on public.establishment_managers (operational_status);


-- ---------------------------------------------------------------------------
-- Listings: tourist spots and accommodations.
-- ---------------------------------------------------------------------------
create table if not exists public.spots (
    id                  text primary key default public.ztims_new_id(),
    title               text not null constraint spots_title_required check (title <> ''),
    -- The short place label on cards and in search.
    location            text not null constraint spots_location_required check (location <> ''),
    category            text not null constraint spots_category_required check (category <> ''),
    description         text not null constraint spots_description_required check (description <> ''),
    -- Cover photo. Only a link; the file lives on Cloudinary. The rest of the
    -- gallery is in spot_photos.
    image_url           text not null default '',
    -- Where "Book Now" sends a visitor: the enterprise's own site.
    booking_url         text not null default '',
    type                text not null default 'spot'
                        constraint spots_type check (type in ('spot', 'accommodation')),
    label               text not null default '',
    working_days        text not null default 'Everyday',
    working_time        text not null default 'All Day',
    travel_fee          numeric not null default 0,
    entrance_fee        numeric not null default 0,
    address             text not null default '',
    -- Every listing is in Zamboanguita, Negros Oriental, so neither is stored:
    -- the API adds them when it reads a listing.
    barangay            text not null default '',
    -- Where the place is. Both or neither: half a point would put a marker in
    -- the sea. A visitor's own position is never stored anywhere.
    latitude            double precision
                        constraint spots_latitude_range check (latitude between -90 and 90),
    longitude           double precision
                        constraint spots_longitude_range check (longitude between -180 and 180),
    -- Which enterprise keeps this listing accurate. Null: the Tourism Office.
    managed_by          text references public.establishment_managers (id),
    -- Listings are taken down by status, never deleted.
    status              text not null default 'published'
                        constraint spots_status check (status in ('published', 'unpublished', 'archived')),
    status_updated_at   timestamptz,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    constraint spots_coordinates_pair check ((latitude is null) = (longitude is null))
);

create index if not exists spots_managed_by_idx on public.spots (managed_by);
create index if not exists spots_status_idx on public.spots (status);
-- A manager account may run any number of enterprises, one listing each
-- (the "One manager, many enterprises" block at the end of this file).
create index if not exists spots_created_at_idx on public.spots (created_at desc);






-- ---------------------------------------------------------------------------
-- Feedback from the public Contact Us page. Resolved, never deleted.
-- ---------------------------------------------------------------------------
create table if not exists public.feedback (
    id                      text primary key default public.ztims_new_id(),
    topic                   text not null default 'other'
                            constraint feedback_topic
                            check (topic in ('suggestion', 'listing', 'problem', 'booking', 'other')),
    message                 text not null
                            constraint feedback_message_length check (char_length(message) between 1 and 2000),
    name                    text not null default '' constraint feedback_name_length check (char_length(name) <= 120),
    email                   text not null default '' constraint feedback_email_length check (char_length(email) <= 254),
    page                    text not null default '' constraint feedback_page_length check (char_length(page) <= 500),
    status                  text not null default 'new'
                            constraint feedback_status check (status in ('new', 'read', 'resolved')),
    status_updated_at       timestamptz,
    status_updated_by_email text not null default '',
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now()
);

create index if not exists feedback_status_idx on public.feedback (status);
create index if not exists feedback_topic_idx on public.feedback (topic);
create index if not exists feedback_created_at_idx on public.feedback (created_at desc);


-- ---------------------------------------------------------------------------
-- Rate-limit counters, shared by every running copy of the API. Not data:
-- every row expires within an hour, and old ones are swept as the API runs.
-- ---------------------------------------------------------------------------
create table if not exists public.rate_limits (
    key                 text primary key,
    hits                integer not null,
    expires_at          timestamptz not null
);

create index if not exists rate_limits_expires_at_idx on public.rate_limits (expires_at);


-- ---------------------------------------------------------------------------
-- Tourism statistics: the monthly counts behind Form A4, "Report on the
-- Regional Distribution of Travelers", and visitor counts at attractions.
--
-- Counts only. There is no column for money (revenue, rates, fees taken) and
-- none for a guest's name or any detail about one person, and there must never
-- be one: an enterprise reports how many guests came from where, nothing
-- more. There are no percentages either; every figure is a count, and every
-- total is added up when it is asked for, never stored.
--
-- Reports are kept for good. A report entered by mistake is voided, not
-- deleted, and every change is written to report_changes.
-- ---------------------------------------------------------------------------

-- The rows of Form A4, in the form's own order. Countries are keyed by their
-- two-letter ISO code; the form's other rows by a word. The pages read this
-- list from the API, so the form and the server can never disagree about it.
create table if not exists public.residences (
    code                text primary key,
    name                text not null,
    -- philippine: residents of the Philippines. foreign: non-Philippine
    -- residents, grouped by continent and region. overseas_filipino and
    -- unspecified: the form's last two rows.
    section             text not null
                        constraint residences_section
                        check (section in ('philippine', 'foreign', 'overseas_filipino', 'unspecified')),
    continent           text not null,
    region              text not null,
    sort_order          integer not null
);

insert into public.residences (code, name, section, continent, region, sort_order) values
    ('ph-filipino', 'Filipino nationality', 'philippine', 'Philippine residents', 'Philippine residents', 10),
    ('ph-foreign', 'Foreign nationality', 'philippine', 'Philippine residents', 'Philippine residents', 20),
    ('BN', 'Brunei', 'foreign', 'Asia', 'ASEAN', 30),
    ('KH', 'Cambodia', 'foreign', 'Asia', 'ASEAN', 40),
    ('ID', 'Indonesia', 'foreign', 'Asia', 'ASEAN', 50),
    ('LA', 'Laos', 'foreign', 'Asia', 'ASEAN', 60),
    ('MY', 'Malaysia', 'foreign', 'Asia', 'ASEAN', 70),
    ('MM', 'Myanmar', 'foreign', 'Asia', 'ASEAN', 80),
    ('SG', 'Singapore', 'foreign', 'Asia', 'ASEAN', 90),
    ('TH', 'Thailand', 'foreign', 'Asia', 'ASEAN', 100),
    ('VN', 'Vietnam', 'foreign', 'Asia', 'ASEAN', 110),
    ('CN', 'China', 'foreign', 'Asia', 'East Asia', 120),
    ('HK', 'Hong Kong', 'foreign', 'Asia', 'East Asia', 130),
    ('JP', 'Japan', 'foreign', 'Asia', 'East Asia', 140),
    ('KR', 'Korea', 'foreign', 'Asia', 'East Asia', 150),
    ('MO', 'Macau', 'foreign', 'Asia', 'East Asia', 160),
    ('TW', 'Taiwan', 'foreign', 'Asia', 'East Asia', 170),
    ('BD', 'Bangladesh', 'foreign', 'Asia', 'South Asia', 180),
    ('IN', 'India', 'foreign', 'Asia', 'South Asia', 190),
    ('IR', 'Iran', 'foreign', 'Asia', 'South Asia', 200),
    ('NP', 'Nepal', 'foreign', 'Asia', 'South Asia', 210),
    ('PK', 'Pakistan', 'foreign', 'Asia', 'South Asia', 220),
    ('LK', 'Sri Lanka', 'foreign', 'Asia', 'South Asia', 230),
    ('BH', 'Bahrain', 'foreign', 'Asia', 'Middle East', 240),
    ('EG', 'Egypt', 'foreign', 'Asia', 'Middle East', 250),
    ('OM', 'Oman', 'foreign', 'Asia', 'Middle East', 260),
    ('JO', 'Jordan', 'foreign', 'Asia', 'Middle East', 270),
    ('KW', 'Kuwait', 'foreign', 'Asia', 'Middle East', 280),
    ('QA', 'Qatar', 'foreign', 'Asia', 'Middle East', 290),
    ('SA', 'Saudi Arabia', 'foreign', 'Asia', 'Middle East', 300),
    ('AE', 'United Arab Emirates', 'foreign', 'Asia', 'Middle East', 310),
    ('CA', 'Canada', 'foreign', 'America', 'North America', 320),
    ('MX', 'Mexico', 'foreign', 'America', 'North America', 330),
    ('US', 'USA', 'foreign', 'America', 'North America', 340),
    ('AR', 'Argentina', 'foreign', 'America', 'South America', 350),
    ('BR', 'Brazil', 'foreign', 'America', 'South America', 360),
    ('CO', 'Colombia', 'foreign', 'America', 'South America', 370),
    ('PE', 'Peru', 'foreign', 'America', 'South America', 380),
    ('VE', 'Venezuela', 'foreign', 'America', 'South America', 390),
    ('AD', 'Andorra', 'foreign', 'Europe', 'Western Europe', 400),
    ('AT', 'Austria', 'foreign', 'Europe', 'Western Europe', 410),
    ('BE', 'Belgium', 'foreign', 'Europe', 'Western Europe', 420),
    ('FR', 'France', 'foreign', 'Europe', 'Western Europe', 430),
    ('DE', 'Germany', 'foreign', 'Europe', 'Western Europe', 440),
    ('LU', 'Luxembourg', 'foreign', 'Europe', 'Western Europe', 450),
    ('NL', 'Netherlands', 'foreign', 'Europe', 'Western Europe', 460),
    ('CH', 'Switzerland', 'foreign', 'Europe', 'Western Europe', 470),
    ('DK', 'Denmark', 'foreign', 'Europe', 'Northern Europe', 480),
    ('FI', 'Finland', 'foreign', 'Europe', 'Northern Europe', 490),
    ('IE', 'Ireland', 'foreign', 'Europe', 'Northern Europe', 500),
    ('NO', 'Norway', 'foreign', 'Europe', 'Northern Europe', 510),
    ('SE', 'Sweden', 'foreign', 'Europe', 'Northern Europe', 520),
    ('GB', 'United Kingdom', 'foreign', 'Europe', 'Northern Europe', 530),
    ('GR', 'Greece', 'foreign', 'Europe', 'Southern Europe', 540),
    ('IT', 'Italy', 'foreign', 'Europe', 'Southern Europe', 550),
    ('PT', 'Portugal', 'foreign', 'Europe', 'Southern Europe', 560),
    ('ES', 'Spain', 'foreign', 'Europe', 'Southern Europe', 570),
    ('cis', 'Commonwealth of Independent States', 'foreign', 'Europe', 'Eastern Europe', 580),
    ('PL', 'Poland', 'foreign', 'Europe', 'Eastern Europe', 590),
    ('RU', 'Russia', 'foreign', 'Europe', 'Eastern Europe', 600),
    ('IL', 'Israel', 'foreign', 'Europe', 'East Mediterranean Europe', 610),
    ('TR', 'Turkey', 'foreign', 'Europe', 'East Mediterranean Europe', 620),
    ('AU', 'Australia', 'foreign', 'Australasia / Pacific', 'Australasia / Pacific', 630),
    ('GU', 'Guam', 'foreign', 'Australasia / Pacific', 'Australasia / Pacific', 640),
    ('NR', 'Nauru', 'foreign', 'Australasia / Pacific', 'Australasia / Pacific', 650),
    ('NZ', 'New Zealand', 'foreign', 'Australasia / Pacific', 'Australasia / Pacific', 660),
    ('PG', 'Papua New Guinea', 'foreign', 'Australasia / Pacific', 'Australasia / Pacific', 670),
    ('NG', 'Nigeria', 'foreign', 'Africa', 'Africa', 680),
    ('ZA', 'South Africa', 'foreign', 'Africa', 'Africa', 690),
    ('other-foreign', 'Others / unspecified', 'foreign', 'Others', 'Others and unspecified', 700),
    ('overseas-filipino', 'Overseas Filipinos', 'overseas_filipino', 'Overseas Filipinos', 'Overseas Filipinos', 710),
    ('unspecified', 'Unspecified residence', 'unspecified', 'Unspecified residence', 'Unspecified residence', 720)
on conflict (code) do update set
    name = excluded.name, section = excluded.section, continent = excluded.continent,
    region = excluded.region, sort_order = excluded.sort_order;

-- One report per place per month: an accommodation's guests, rooms and nights,
-- or an attraction's visitors. A 'municipal_total' report belongs to no place:
-- it holds a month from before ZTIMS collected per place (the 2025 sheet),
-- already added up for the whole municipality.
create table if not exists public.monthly_reports (
    id                  text primary key default public.ztims_new_id(),
    kind                text not null
                        constraint monthly_reports_kind
                        check (kind in ('accommodation', 'attraction', 'municipal_total')),
    spot_id             text references public.spots (id),
    year                integer not null constraint monthly_reports_year check (year between 2000 and 2100),
    month               integer not null constraint monthly_reports_month check (month between 1 and 12),
    -- Accommodations only (and municipal totals). An attraction has visitors,
    -- not rooms or nights.
    rooms               integer constraint monthly_reports_rooms check (rooms is null or rooms >= 0),
    room_nights_occupied integer
                        constraint monthly_reports_room_nights check (room_nights_occupied is null or room_nights_occupied >= 0),
    guest_nights        integer constraint monthly_reports_guest_nights check (guest_nights is null or guest_nights >= 0),
    status              text not null default 'submitted'
                        constraint monthly_reports_status check (status in ('submitted', 'void')),
    void_reason         text not null default '',
    -- Who sent it, as what, by email, so the record outlives the account.
    submitted_by_role   text not null default '',
    submitted_by_email  text not null default '',
    submitted_at        timestamptz not null default now(),
    -- Set when the officer marks the month as sent to the province. A locked
    -- report is changed only after the officer unlocks it.
    locked_at           timestamptz,
    locked_by_email     text not null default '',
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    constraint monthly_reports_place check ((kind = 'municipal_total') = (spot_id is null)),
    constraint monthly_reports_attraction_counts_only
        check (kind <> 'attraction' or (rooms is null and room_nights_occupied is null and guest_nights is null)),
    -- Room-nights occupied can never be more than rooms × days in the month.
    constraint monthly_reports_room_nights_fit
        check (room_nights_occupied is null or rooms is null or room_nights_occupied <=
               rooms * extract(day from (make_date(year, month, 1) + interval '1 month' - interval '1 day')))
);

-- A voided report stays, but only one live report per place and month.
create unique index if not exists monthly_reports_one_per_place
    on public.monthly_reports (spot_id, year, month) where status = 'submitted' and spot_id is not null;
create unique index if not exists monthly_reports_one_municipal_total
    on public.monthly_reports (year, month) where status = 'submitted' and kind = 'municipal_total';
create index if not exists monthly_reports_period_idx on public.monthly_reports (year, month);
create index if not exists monthly_reports_spot_idx on public.monthly_reports (spot_id);

-- A report's numbers: one row per residence that had anyone. Male and female
-- are both given, or (for the 2025 sheet, which never split by sex) neither,
-- and then total_unsplit holds the count. `total` is never typed in: the
-- database works it out, so it can never disagree with the parts.
create table if not exists public.monthly_report_counts (
    report_id           text not null references public.monthly_reports (id),
    residence_code      text not null references public.residences (code),
    male                integer constraint monthly_report_counts_male check (male is null or male >= 0),
    female              integer constraint monthly_report_counts_female check (female is null or female >= 0),
    total_unsplit       integer constraint monthly_report_counts_total_unsplit check (total_unsplit is null or total_unsplit >= 0),
    total               integer generated always as (coalesce(male + female, total_unsplit)) stored,
    primary key (report_id, residence_code),
    constraint monthly_report_counts_split_or_not
        check ((male is null) = (female is null) and (male is null) = (total_unsplit is not null))
);

create index if not exists monthly_report_counts_residence_idx on public.monthly_report_counts (residence_code);

-- The Guest Register: a place's own log of each stay (a place to stay: check-in
-- date, nights, rooms) or each group (an attraction: the date), kept through
-- the month so the monthly report can be filled from it. Counts only: who came
-- from where, male and female, never a name. The monthly report stays the
-- record; this only helps fill it in.
create table if not exists public.register_entries (
    id                  text primary key default public.ztims_new_id(),
    spot_id             text not null references public.spots (id),
    entry_date          date not null,
    nights              integer constraint register_entries_nights check (nights is null or nights between 1 and 365),
    rooms               integer constraint register_entries_rooms check (rooms is null or rooms between 1 and 1000),
    created_by_email    text not null default '',
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    -- A stay has both nights and rooms; a group at an attraction has neither.
    constraint register_entries_stay_or_group check ((nights is null) = (rooms is null))
);
create index if not exists register_entries_spot_date_idx on public.register_entries (spot_id, entry_date);

create table if not exists public.register_entry_guests (
    entry_id            text not null references public.register_entries (id) on delete cascade,
    residence_code      text not null references public.residences (code),
    male                integer not null default 0 constraint register_entry_guests_male check (male between 0 and 10000),
    female              integer not null default 0 constraint register_entry_guests_female check (female between 0 and 10000),
    primary key (entry_id, residence_code),
    constraint register_entry_guests_someone check (male + female > 0)
);

-- Every change to a report: what it was, what it became, who and when.
create table if not exists public.report_changes (
    id                  text primary key default public.ztims_new_id(),
    report_id           text not null references public.monthly_reports (id),
    action              text not null
                        constraint report_changes_action
                        check (action in ('created', 'updated', 'voided', 'locked', 'unlocked')),
    changed_by_role     text not null default '',
    changed_by_email    text not null default '',
    note                text not null default '' constraint report_changes_note_length check (char_length(note) <= 500),
    before              jsonb,
    after               jsonb,
    changed_at          timestamptz not null default now()
);

create index if not exists report_changes_report_idx on public.report_changes (report_id, changed_at desc);


-- ---------------------------------------------------------------------------
-- Online payments — a DEMONSTRATION, in the payment gateway's test mode.
--
-- A visitor may buy an entrance ticket to an attraction
-- the office runs, through the gateway's checkout. The API refuses to start with
-- a live key, so no real money can move: every online payment is a test one.
-- Records made for the demonstration carry is_demo, and the officer can remove
-- them all at once. The gateway keeps the card and wallet details; nothing here
-- does. Money stays out of the statistics tables above.
-- ---------------------------------------------------------------------------


-- An entrance ticket: one date, one attraction, a number of people.
create table if not exists public.tickets (
    id                  text primary key default public.ztims_new_id(),
    -- What the visitor shows at the gate, e.g. JF-7K3M-Q. Unique for good.
    code                text not null unique,
    spot_id             text not null references public.spots (id),
    visit_date          date not null,
    -- How many of each kind of visitor. The staff at the entrance see the kinds,
    -- to check a student ID.
    count_regular       integer not null default 0,
    count_student       integer not null default 0,
    count_child         integer not null default 0,
    -- The price per person each kind paid, fixed when the ticket was bought (a
    -- receipt keeps the price of the day). Null: that kind was not offered.
    fee_regular         numeric,
    fee_student         numeric,
    fee_child           numeric,
    -- Worked out by the database from the columns above, never typed in.
    people              integer generated always as
                        (count_regular + count_student + count_child) stored,
    amount              numeric generated always as
                        (coalesce(count_regular * fee_regular, 0) + coalesce(count_student * fee_student, 0)
                         + coalesce(count_child * fee_child, 0)) stored,
    full_name           text not null,
    email               text not null,
    contact_number      text not null default '',
    status              text not null default 'pending_payment'
                        constraint tickets_status
                        check (status in ('pending_payment', 'valid', 'used', 'cancelled', 'expired')),
    used_at             timestamptz,
    used_by_email       text not null default '',
    is_demo             boolean not null default false,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists tickets_spot_date_idx on public.tickets (spot_id, visit_date);
create index if not exists tickets_status_idx on public.tickets (status);

-- (A database from before the counts and per-kind prices is brought to this
-- shape in "Normalisation" at the end of this file.)

-- A payment, for one ticket: paid online, or recorded by the office. Online
-- payments keep the gateway's reference, and may be refunded. (A database from
-- before keeps its older columns until "Tour guides taken out", at the end.)
create table if not exists public.payments (
    id                  text primary key default public.ztims_new_id(),
    ticket_id           text not null unique references public.tickets (id),
    amount              numeric not null constraint payments_amount_not_negative check (amount >= 0),
    method              text not null default 'cash',
    receipt_number      text not null default '',
    paid_at             timestamptz not null default now(),
    -- Who took it, by email, so the record outlives the account.
    recorded_by_email   text not null default '',
    remarks             text not null default '',
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);
alter table public.payments add column if not exists ticket_id text unique references public.tickets (id);
alter table public.payments add column if not exists channel text not null default 'counter';
alter table public.payments add column if not exists gateway_ref text not null default '';
alter table public.payments add column if not exists refunded_at timestamptz;
alter table public.payments add column if not exists refund_reason text not null default '';
alter table public.payments add column if not exists refunded_by_email text not null default '';
alter table public.payments add column if not exists is_demo boolean not null default false;
-- How much went back. Null on a refund from before partial refunds: all of it.
-- A visitor's own cancellation returns the amount less the share the office
-- keeps (spots.cancel_keep_percent); the office's cancellation returns it all.
alter table public.payments add column if not exists refund_amount numeric;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'payments_channel') then
        alter table public.payments add constraint payments_channel check (channel in ('counter', 'online'));
    end if;
end
$$;

create index if not exists payments_paid_at_idx on public.payments (paid_at desc);

-- One trip to the gateway's checkout page. Kept whatever became of it, so a
-- payment that arrives late, or twice, can still be matched to what it was for.
create table if not exists public.online_checkouts (
    id                  text primary key default public.ztims_new_id(),
    ticket_id           text not null references public.tickets (id) on delete cascade,
    amount              numeric not null constraint online_checkouts_amount check (amount >= 0),
    session_id          text unique,
    checkout_url        text not null default '',
    status              text not null default 'pending'
                        constraint online_checkouts_status
                        check (status in ('pending', 'paid', 'expired', 'duplicate')),
    method              text not null default '',
    payment_ref         text not null default '',
    expires_at          timestamptz not null,
    paid_at             timestamptz,
    is_demo             boolean not null default true,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists online_checkouts_ticket_idx on public.online_checkouts (ticket_id);


-- ---------------------------------------------------------------------------
-- Attraction setup: the office decides, per destination, what each kind of
-- visitor pays, which days it opens, which dates it is shut, and how much of a
-- visitor's own cancellation it keeps.
--
-- Opening days live in spots.working_days, the text visitors already read
-- ("Monday to Saturday"); open-days.js reads and writes it. A student or child
-- price left empty is not offered. The cancellation percentage applies to that destination's tickets.
-- ---------------------------------------------------------------------------
alter table public.spots add column if not exists student_fee numeric;
alter table public.spots add column if not exists child_fee numeric;
alter table public.spots add column if not exists child_age_max integer;
alter table public.spots add column if not exists cancel_keep_percent numeric not null default 0;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'spots_student_fee') then
        alter table public.spots add constraint spots_student_fee check (student_fee is null or student_fee >= 0);
    end if;
    if not exists (select 1 from pg_constraint where conname = 'spots_child_fee') then
        alter table public.spots add constraint spots_child_fee check (child_fee is null or child_fee >= 0);
    end if;
    if not exists (select 1 from pg_constraint where conname = 'spots_child_age_max') then
        alter table public.spots add constraint spots_child_age_max check (child_age_max is null or child_age_max between 1 and 17);
    end if;
    if not exists (select 1 from pg_constraint where conname = 'spots_cancel_keep_percent') then
        alter table public.spots add constraint spots_cancel_keep_percent check (cancel_keep_percent between 0 and 100);
    end if;
end
$$;

-- Closures: when the office shuts a destination on a date that already has
-- sales, each paid ticket for it becomes 'closed' — out of use,
-- waiting for the visitor to choose a full refund or a new date (Manage page).
-- Unpaid ones are simply cancelled. The constraints are redrawn every migrate,
-- so they always carry the current list.
alter table public.tickets drop constraint if exists tickets_status;
alter table public.tickets add constraint tickets_status
    check (status in ('pending_payment', 'valid', 'used', 'cancelled', 'expired', 'closed'));

-- A date a destination is shut (a fiesta, repairs, a typhoon). Tickets are
-- refused for it. Closing a date that already has sales is the
-- closure action's job: it cancels them and tells each visitor.
create table if not exists public.spot_closed_dates (
    id                  text primary key default public.ztims_new_id(),
    spot_id             text not null references public.spots (id) on delete cascade,
    closed_date         date not null,
    reason              text not null default ''
                        constraint spot_closed_dates_reason_length check (char_length(reason) <= 200),
    created_by_email    text not null default '',
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    constraint spot_closed_dates_once unique (spot_id, closed_date)
);


-- ---------------------------------------------------------------------------
-- Normalisation (October 2026): one fact in one place.
--
-- A destination's gallery is a table of its own (one row per photo) and a
-- ticket's prices are one value per column, and every total
-- (a ticket's people and amount, a statistics row's total) is worked out by the database rather than typed in. Columns nothing used
-- are gone: a listing's municipality and province (always Zamboanguita, Negros
-- Oriental), its status note, and the account ids beside the emails that
-- already say who recorded a payment or sent a report.
--
-- What a record keeps about the moment it happened stays: the price a ticket
-- was bought at, who recorded or changed something. Those are facts of that record, as a receipt keeps its price.
--
-- A database created before this is converted below, its data carried across
-- first; one created after has nothing to convert.
-- ---------------------------------------------------------------------------
create table if not exists public.spot_photos (
    spot_id             text not null references public.spots (id) on delete cascade,
    -- The gallery's order; at most 30 photos (0–29).
    position            integer not null constraint spot_photos_position check (position between 0 and 29),
    url                 text not null constraint spot_photos_url_required check (url <> ''),
    primary key (spot_id, position)
);

do $$
declare
    has_column boolean;
begin
    -- Spots: the photo list becomes rows; unused columns go.
    select exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'spots' and column_name = 'images') into has_column;
    if has_column then
        execute $sql$
            insert into public.spot_photos (spot_id, position, url)
            select s.id, p.ord - 1, p.url
              from public.spots s, unnest(s.images) with ordinality as p(url, ord)
             where p.url <> '' and p.ord <= 30
            on conflict do nothing $sql$;
        alter table public.spots drop column images;
    end if;
    alter table public.spots drop column if exists municipality;
    alter table public.spots drop column if exists province;
    alter table public.spots drop column if exists status_note;


    -- Who did it is the email; the account id beside it was never read.
    alter table public.payments drop column if exists recorded_by;
    alter table public.monthly_reports drop column if exists submitted_by_id;

    -- Statistics rows: total is worked out from male + female, or kept as
    -- total_unsplit for a month with no split (the 2025 sheet).
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'monthly_report_counts'
                  and column_name = 'total' and is_generated = 'NEVER') then
        alter table public.monthly_report_counts add column if not exists total_unsplit integer;
        execute 'update public.monthly_report_counts set total_unsplit = total where male is null';
        alter table public.monthly_report_counts drop column total;
        alter table public.monthly_report_counts
            add column total integer generated always as (coalesce(male + female, total_unsplit)) stored;
    end if;

    -- Tickets: the per-kind prices become columns; people and amount are worked out.
    alter table public.tickets add column if not exists count_regular integer not null default 0;
    alter table public.tickets add column if not exists count_student integer not null default 0;
    alter table public.tickets add column if not exists count_child integer not null default 0;
    alter table public.tickets add column if not exists fee_regular numeric;
    alter table public.tickets add column if not exists fee_student numeric;
    alter table public.tickets add column if not exists fee_child numeric;
    select exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'tickets' and column_name = 'fee_breakdown') into has_column;
    if has_column then
        -- Tickets of that time could still count senior citizens and PWDs.
        alter table public.tickets add column if not exists count_senior integer not null default 0;
        alter table public.tickets add column if not exists count_pwd integer not null default 0;
        alter table public.tickets add column if not exists fee_senior numeric;
        alter table public.tickets add column if not exists fee_pwd numeric;
        -- Tickets from before the kinds were all at the regular price.
        execute $sql$
            update public.tickets
               set count_regular = people
             where count_regular + count_senior + count_pwd + count_student + count_child = 0 $sql$;
        execute $sql$
            update public.tickets
               set fee_regular = coalesce((fee_breakdown->>'regular')::numeric, unit_fee),
                   fee_senior  = (fee_breakdown->>'senior')::numeric,
                   fee_pwd     = (fee_breakdown->>'pwd')::numeric,
                   fee_student = (fee_breakdown->>'student')::numeric,
                   fee_child   = (fee_breakdown->>'child')::numeric $sql$;
        -- Nothing is dropped unless the worked-out figures match what was stored.
        if exists (select 1 from public.tickets
                    where count_regular + count_senior + count_pwd + count_student + count_child <> people
                       or coalesce(count_regular * fee_regular, 0) + coalesce(count_senior * fee_senior, 0)
                          + coalesce(count_pwd * fee_pwd, 0) + coalesce(count_student * fee_student, 0)
                          + coalesce(count_child * fee_child, 0) <> amount) then
            raise exception 'A ticket''s people or amount does not match its counts and prices; nothing was changed.';
        end if;
        alter table public.tickets drop column fee_breakdown;
        alter table public.tickets drop column unit_fee;
    end if;
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'tickets'
                  and column_name = 'people' and is_generated = 'NEVER') then
        alter table public.tickets drop column people;
        alter table public.tickets add column people integer generated always as
            (count_regular + count_senior + count_pwd + count_student + count_child) stored;
    end if;
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'tickets'
                  and column_name = 'amount' and is_generated = 'NEVER') then
        alter table public.tickets drop column amount;
        alter table public.tickets add column amount numeric generated always as
            (coalesce(count_regular * fee_regular, 0) + coalesce(count_senior * fee_senior, 0)
             + coalesce(count_pwd * fee_pwd, 0) + coalesce(count_student * fee_student, 0)
             + coalesce(count_child * fee_child, 0)) stored;
    end if;

    -- Senior citizen and PWD prices were taken away (October 2026, the user's
    -- decision). Their columns go once no ticket counts anyone in them, so no
    -- ticket ever loses what it recorded; until then they stay, unused.
    -- (Two steps: the second may only be read where the columns exist.)
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'tickets' and column_name = 'count_senior') then
        if not exists (select 1 from public.tickets where count_senior <> 0 or count_pwd <> 0) then
            alter table public.tickets drop constraint if exists tickets_counts_not_negative;
            alter table public.tickets drop constraint if exists tickets_fees_not_negative;
            alter table public.tickets drop constraint if exists tickets_priced_by_kind;
            alter table public.tickets drop constraint if exists tickets_people;
            alter table public.tickets drop column people;
            alter table public.tickets drop column amount;
            alter table public.tickets drop column count_senior, drop column count_pwd,
                                       drop column fee_senior, drop column fee_pwd;
            alter table public.tickets add column people integer generated always as
                (count_regular + count_student + count_child) stored;
            alter table public.tickets add column amount numeric generated always as
                (coalesce(count_regular * fee_regular, 0) + coalesce(count_student * fee_student, 0)
                 + coalesce(count_child * fee_child, 0)) stored;
        end if;
    end if;


    -- The rules, for a converted database and a new one alike.
    if not exists (select 1 from pg_constraint where conname = 'monthly_report_counts_split_or_not') then
        alter table public.monthly_report_counts add constraint monthly_report_counts_split_or_not
            check ((male is null) = (female is null) and (male is null) = (total_unsplit is not null));
    end if;
    if not exists (select 1 from pg_constraint where conname = 'monthly_report_counts_total_unsplit') then
        alter table public.monthly_report_counts add constraint monthly_report_counts_total_unsplit
            check (total_unsplit is null or total_unsplit >= 0);
    end if;
    if not exists (select 1 from pg_constraint where conname = 'tickets_counts_not_negative') then
        alter table public.tickets add constraint tickets_counts_not_negative
            check (count_regular >= 0 and count_student >= 0 and count_child >= 0);
    end if;
    if not exists (select 1 from pg_constraint where conname = 'tickets_people') then
        alter table public.tickets add constraint tickets_people check (people between 1 and 50);
    end if;
    if not exists (select 1 from pg_constraint where conname = 'tickets_fees_not_negative') then
        alter table public.tickets add constraint tickets_fees_not_negative
            check (coalesce(fee_regular, 0) >= 0 and coalesce(fee_student, 0) >= 0 and coalesce(fee_child, 0) >= 0);
    end if;
    -- A kind with people on the ticket has its price.
    if not exists (select 1 from pg_constraint where conname = 'tickets_priced_by_kind') then
        alter table public.tickets add constraint tickets_priced_by_kind
            check ((count_regular = 0 or fee_regular is not null) and (count_student = 0 or fee_student is not null)
                   and (count_child = 0 or fee_child is not null));
    end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Categories (October 2026): what a place is known for, by the visitor's
-- purpose — BEACH (Beach & Sea), DIVING (Diving & Snorkeling), NATURE,
-- ADVENTURE, CULTURE (Culture & Heritage), FAITH, and LEISURE (Leisure &
-- Recreation: swimming pools, water parks, parks; added October 2026). One place can be several:
-- spots.category is the main one, spot_more_categories holds any others (one
-- row each, never the main one again). Whether it is a place to stay is a
-- separate fact, spots.type ('accommodation' | 'spot').
--
-- Before this a listing had one of MOUNTAIN, BEACH / DIVING, CULTURAL and
-- ACCOMMODATION, and ACCOMMODATION also meant "a place to stay". Those are
-- converted below, once (only rows still holding an old value are touched):
-- ACCOMMODATION -> a place to stay, Beach & Sea if its words speak of the sea,
-- else Nature; BEACH / DIVING -> Beach & Sea + Diving (Diving first when the
-- name says reef or sanctuary); MOUNTAIN -> Nature (+ Adventure when the name
-- says peak, ridge or trail); CULTURAL -> Culture & Heritage (Faith first when
-- the name says church or shrine). Managers and the office adjust from there.
-- ---------------------------------------------------------------------------
create table if not exists public.spot_more_categories (
    spot_id             text not null references public.spots (id) on delete cascade,
    position            integer not null constraint spot_more_categories_position check (position between 0 and 5),
    category            text not null constraint spot_more_categories_known
                        check (category in ('BEACH', 'DIVING', 'NATURE', 'ADVENTURE', 'CULTURE', 'FAITH', 'LEISURE')),
    primary key (spot_id, position),
    constraint spot_more_categories_once unique (spot_id, category)
);

do $$
begin
    drop table if exists ztims_old_categories;
    create temporary table ztims_old_categories on commit drop as
    select id,
           upper(btrim(category)) as old,
           coalesce(title, '') as name,
           coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(label, '') as words
      from public.spots
     where category not in ('BEACH', 'DIVING', 'NATURE', 'ADVENTURE', 'CULTURE', 'FAITH', 'LEISURE');

    -- The other categories first, from the old values.
    insert into public.spot_more_categories (spot_id, position, category)
    select id, 0,
           case when name ~* '(div|reef|snorkel|sanctuary|marine)' then 'BEACH' else 'DIVING' end
      from ztims_old_categories where old = 'BEACH / DIVING'
    union all
    select id, 0, 'ADVENTURE'
      from ztims_old_categories where old = 'MOUNTAIN' and name ~* '(peak|ridge|trek|hik|trail|climb|summit)'
    union all
    select id, 0, 'CULTURE'
      from ztims_old_categories where old = 'CULTURAL' and name ~* '(church|chapel|shrine|cathedral|parish|pilgrim)'
    on conflict do nothing;

    update public.spots s
       set type = case when o.old = 'ACCOMMODATION' then 'accommodation' else s.type end,
           category = case
               when o.old = 'ACCOMMODATION' then
                   case when o.words ~* '(beach|sea|cove|shore|island|div|snorkel|reef)' then 'BEACH' else 'NATURE' end
               when o.old = 'BEACH / DIVING' then
                   case when o.name ~* '(div|reef|snorkel|sanctuary|marine)' then 'DIVING' else 'BEACH' end
               when o.old = 'CULTURAL' then
                   case when o.name ~* '(church|chapel|shrine|cathedral|parish|pilgrim)' then 'FAITH' else 'CULTURE' end
               else 'NATURE'
           end
      from ztims_old_categories o
     where o.id = s.id;

    alter table public.spots drop constraint if exists spots_category_known;
    alter table public.spots add constraint spots_category_known
        check (category in ('BEACH', 'DIVING', 'NATURE', 'ADVENTURE', 'CULTURE', 'FAITH', 'LEISURE'));
    -- Redrawn every migrate, so a database made before LEISURE accepts it.
    alter table public.spot_more_categories drop constraint if exists spot_more_categories_known;
    alter table public.spot_more_categories add constraint spot_more_categories_known
        check (category in ('BEACH', 'DIVING', 'NATURE', 'ADVENTURE', 'CULTURE', 'FAITH', 'LEISURE'));
end
$$;

-- ---------------------------------------------------------------------------
-- Settings: who each Tourism Officer is, and the office's public contact
-- details (the officer's Settings page).
-- ---------------------------------------------------------------------------

-- An officer is a named person with a position, not just an email. `active`:
-- an officer who leaves is deactivated, never deleted, so what they recorded
-- (by email) still says who did it. `last_sign_in_at` is set at each sign-in.
alter table public.tourism_officers add column if not exists full_name text not null default '';
alter table public.tourism_officers add column if not exists position text not null default '';
alter table public.tourism_officers add column if not exists contact_number text not null default '';
alter table public.tourism_officers add column if not exists active boolean not null default true;
alter table public.tourism_officers add column if not exists last_sign_in_at timestamptz;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'tourism_officers_text_lengths') then
        alter table public.tourism_officers add constraint tourism_officers_text_lengths
            check (char_length(full_name) <= 120 and char_length(position) <= 120 and char_length(contact_number) <= 40);
    end if;
end
$$;

-- The office's contact details, shown on the public site (footer, Contact Us).
-- One row only: there is one Municipal Tourism Office.
create table if not exists public.office_info (
    id                  smallint primary key default 1 constraint office_info_one_row check (id = 1),
    address             text not null default ''
                        constraint office_info_address_length check (char_length(address) <= 300),
    phone               text not null default ''
                        constraint office_info_phone_length check (char_length(phone) <= 40),
    email               text not null default ''
                        constraint office_info_email_length check (char_length(email) <= 254),
    office_hours        text not null default ''
                        constraint office_info_hours_length check (char_length(office_hours) <= 120),
    updated_by_email    text not null default '',
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

insert into public.office_info (id, address, office_hours)
values (1, 'Municipal Hall, Poblacion, Zamboanguita, Negros Oriental 6218', 'Monday to Friday, 8:00 AM – 5:00 PM')
on conflict (id) do nothing;

-- Emergency numbers, one row each, in the order the office lists them. Shown in
-- the footer and on every destination page; nothing shows while there are none.
create table if not exists public.emergency_numbers (
    id                  text primary key default public.ztims_new_id(),
    label               text not null
                        constraint emergency_numbers_label_length check (char_length(btrim(label)) between 1 and 80),
    number              text not null
                        constraint emergency_numbers_number_length check (char_length(btrim(number)) between 3 and 40),
    position            integer not null default 0,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists emergency_numbers_position_idx on public.emergency_numbers (position);

-- ---------------------------------------------------------------------------
-- Sign-in safety (October 2026).
--
-- `session_version` is written into every sign-in token. Changing a password,
-- having one issued, or pressing "Sign out of all devices" adds one to it,
-- and every token carrying the old number stops working at once.
-- `must_change_password` is set when someone else chose the password (an
-- officer issuing one, or the first officer from the environment); its owner
-- sets their own before doing anything else.
-- ---------------------------------------------------------------------------
alter table public.tourism_officers add column if not exists session_version integer not null default 0;
alter table public.tourism_officers add column if not exists must_change_password boolean not null default false;
alter table public.establishment_managers add column if not exists session_version integer not null default 0;
alter table public.establishment_managers add column if not exists must_change_password boolean not null default false;

-- Data privacy (Data Privacy Act of 2012): the office's Data Protection Officer,
-- published on the Privacy page, and when the one-year erasure last ran.
alter table public.office_info add column if not exists dpo_name text not null default '';
alter table public.office_info add column if not exists dpo_email text not null default '';
alter table public.office_info add column if not exists privacy_checked_at timestamptz;

-- Office Information's "last updated" means the details people read changed;
-- the daily privacy run writing privacy_checked_at is not that, so office_info
-- has its own touch that ignores it (and is left out of the loop below).
create or replace function public.ztims_touch_office_info()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if (new.address, new.phone, new.email, new.office_hours, new.dpo_name, new.dpo_email)
       is distinct from (old.address, old.phone, old.email, old.office_hours, old.dpo_name, old.dpo_email) then
        new.updated_at = pg_catalog.now();
    end if;
    return new;
end
$$;

drop trigger if exists office_info_touch_updated_at on public.office_info;
create trigger office_info_touch_updated_at before update on public.office_info
    for each row execute function public.ztims_touch_office_info();

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'office_info_dpo_lengths') then
        alter table public.office_info add constraint office_info_dpo_lengths
            check (char_length(dpo_name) <= 120 and char_length(dpo_email) <= 254);
    end if;
end
$$;


-- ---------------------------------------------------------------------------
-- Announcements and the calendar of events (November 2026). Only the Tourism
-- Officer posts; a notice is live when saved and leaves the public site after
-- its end. Never deleted: `hidden` takes one down and brings it back.
-- ---------------------------------------------------------------------------
create table if not exists public.announcements (
    id                  text primary key default public.ztims_new_id(),
    category            text not null
                        constraint announcements_category
                        check (category in ('advisory', 'event', 'closure', 'general')),
    title               text not null
                        constraint announcements_title_length check (char_length(btrim(title)) between 1 and 140),
    body                text not null
                        constraint announcements_body_length check (char_length(btrim(body)) between 1 and 4000),
    -- The same notice in Filipino or Bisaya, when the office writes one.
    body_other          text not null default ''
                        constraint announcements_body_other_length check (char_length(body_other) <= 4000),
    starts_at           timestamptz not null,
    ends_at             timestamptz not null,
    spot_id             text references public.spots (id),
    photo_url           text not null default ''
                        constraint announcements_photo_url_length check (char_length(photo_url) <= 500),
    hidden              boolean not null default false,
    created_by_email    text not null default '',
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    constraint announcements_ends_after_start check (ends_at >= starts_at)
);

create index if not exists announcements_hidden_ends_idx on public.announcements (hidden, ends_at);
create index if not exists announcements_category_starts_idx on public.announcements (category, starts_at);
create index if not exists announcements_spot_idx on public.announcements (spot_id);



-- ---------------------------------------------------------------------------
-- Room booking: repairing an early draft (11 November 2026). One live database
-- received the booking tables before their final shape: bookings without
-- requested_at, room_types.beds as text, older checks and defaults. "create
-- table if not exists" never corrects an existing table, so: when that draft
-- is found AND all seven booking tables are empty, they are dropped here and
-- recreated as defined just below. With any row in any of them, nothing is
-- dropped and a notice says so (fix by hand, with the user's yes). The foreign
-- keys other tables had to bookings are put back at the end of this file.
-- ---------------------------------------------------------------------------
do $$
declare drafted boolean; rows_found bigint := 0; t text;
begin
    drafted := (exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'bookings')
                and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bookings' and column_name = 'requested_at'))
            or exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'room_types' and column_name = 'beds' and data_type = 'text');
    if not drafted then return; end if;
    foreach t in array array['enterprise_booking_settings', 'room_types', 'room_blocks', 'bookings', 'booking_rooms', 'booking_changes', 'booking_payments'] loop
        if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = t) then
            execute format('select count(*) from public.%I', t) into strict rows_found;
            if rows_found > 0 then
                raise notice 'Booking tables are an early draft but % holds % row(s): left as they are. Repair by hand.', t, rows_found;
                return;
            end if;
        end if;
    end loop;
    drop table if exists public.booking_payments, public.booking_changes, public.booking_rooms, public.bookings,
                         public.room_blocks, public.room_types, public.enterprise_booking_settings cascade;
    raise notice 'Early-draft booking tables were empty: dropped, recreated below.';
end $$;

-- ---------------------------------------------------------------------------
-- Room booking (November 2026, decided 8 November; bookings.js). A private
-- place to stay takes booking requests for its own rooms; its manager
-- confirms or declines each by hand. ZTIMS never holds the money: the guest
-- pays the resort as it instructs, and the manager may record that payment.
-- A booking is not a count: a guest is counted only through the Guest
-- Register entry the manager saves at check-in. Nothing here is deleted:
-- bookings end Declined, Expired, Cancelled, Completed or No-show, with every
-- change in booking_changes.
-- ---------------------------------------------------------------------------
create table if not exists public.enterprise_booking_settings (
    spot_id                 text primary key references public.spots (id),
    -- The manager's switch, and the Tourism Office's pause over it: bookings
    -- are open only while the first is on and the second off.
    accepts_bookings        boolean not null default false,
    paused_by_office        boolean not null default false,
    response_hours          integer not null default 24
                            constraint booking_settings_response_hours check (response_hours between 1 and 72),
    check_in_time           time not null default '14:00',
    check_out_time          time not null default '12:00',
    min_nights              integer not null default 1,
    max_nights              integer not null default 14,
    -- How many days ahead a stay can start.
    advance_days            integer not null default 180
                            constraint booking_settings_advance_days check (advance_days between 1 and 730),
    -- Moves and cancellations close this many days before check-in.
    free_cancel_days        integer not null default 2
                            constraint booking_settings_free_cancel_days check (free_cancel_days between 0 and 60),
    payment_instructions    text not null default ''
                            constraint booking_settings_payment_instructions_length check (char_length(payment_instructions) <= 2000),
    updated_by_email        text not null default '',
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now(),
    constraint booking_settings_nights check (min_nights between 1 and 60 and max_nights between min_nights and 60)
);

create table if not exists public.room_types (
    id                  text primary key default public.ztims_new_id(),
    spot_id             text not null references public.spots (id),
    name                text not null constraint room_types_name_length check (char_length(btrim(name)) between 1 and 80),
    description         text not null default '' constraint room_types_description_length check (char_length(description) <= 1000),
    beds                integer not null default 1 constraint room_types_beds check (beds between 1 and 20),
    max_guests          integer not null default 2 constraint room_types_max_guests check (max_guests between 1 and 30),
    -- One price per room per night until seasonal rates (a later version).
    base_rate           numeric(10, 2) not null constraint room_types_base_rate check (base_rate > 0 and base_rate <= 1000000),
    -- How many rooms of this type the place has.
    units               integer not null constraint room_types_units check (units between 1 and 500),
    photo_url           text not null default '' constraint room_types_photo_url_length check (char_length(photo_url) <= 500),
    -- Retired, never deleted: old bookings still point at it.
    active              boolean not null default true,
    position            integer not null default 0,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);
create index if not exists room_types_spot_idx on public.room_types (spot_id, position);

-- Rooms taken out of booking on some nights (repairs, a private event):
-- `units` rooms of the type, every night from starts_on to ends_on inclusive.
create table if not exists public.room_blocks (
    id                  text primary key default public.ztims_new_id(),
    room_type_id        text not null references public.room_types (id),
    starts_on           date not null,
    ends_on             date not null,
    units               integer not null constraint room_blocks_units check (units between 1 and 500),
    reason              text not null default '' constraint room_blocks_reason_length check (char_length(reason) <= 200),
    created_by_email    text not null default '',
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    constraint room_blocks_dates check (ends_on >= starts_on)
);
create index if not exists room_blocks_type_dates_idx on public.room_blocks (room_type_id, starts_on, ends_on);

create table if not exists public.bookings (
    id                  text primary key default public.ztims_new_id(),
    -- What the guest is given and types on the Manage page, with the email.
    code                text not null unique,
    spot_id             text not null references public.spots (id),
    guest_name          text not null constraint bookings_guest_name_length check (char_length(guest_name) between 1 and 120),
    email               text not null default '' constraint bookings_email_length check (char_length(email) <= 254),
    phone               text not null default '' constraint bookings_phone_length check (char_length(phone) <= 40),
    -- Where the guest lives (Form A4's rows), for the Guest Register at check-in.
    country_code        text not null references public.residences (code),
    adults              integer not null constraint bookings_adults check (adults between 1 and 100),
    children            integer not null default 0 constraint bookings_children check (children between 0 and 100),
    check_in            date not null,
    check_out           date not null,
    nights              integer generated always as (check_out - check_in) stored,
    status              text not null default 'requested'
                        constraint bookings_status check (status in
                            ('requested', 'confirmed', 'checked_in', 'completed', 'declined', 'expired', 'cancelled', 'no_show')),
    -- Worked out by the server from the rooms' prices; the manager may adjust
    -- it once, before confirming, with a reason (booking_changes).
    total_amount        numeric(12, 2) not null constraint bookings_total_amount check (total_amount >= 0),
    note                text not null default '' constraint bookings_note_length check (char_length(note) <= 1000),
    -- A request is held until then; unanswered, it expires and frees the rooms.
    requested_at        timestamptz not null default now(),
    expires_at          timestamptz,
    reminder_sent_at    timestamptz,
    decided_by_email    text not null default '',
    decided_at          timestamptz,
    decline_reason      text not null default '' constraint bookings_decline_reason_length check (char_length(decline_reason) <= 300),
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    constraint bookings_dates check (check_out > check_in)
);
create index if not exists bookings_spot_dates_idx on public.bookings (spot_id, check_in, check_out);
create index if not exists bookings_status_expires_idx on public.bookings (status, expires_at);

-- Which rooms a booking holds, at the price each had when it was made.
create table if not exists public.booking_rooms (
    booking_id          text not null references public.bookings (id),
    room_type_id        text not null references public.room_types (id),
    units               integer not null constraint booking_rooms_units check (units between 1 and 50),
    rate_per_night      numeric(10, 2) not null constraint booking_rooms_rate check (rate_per_night >= 0),
    primary key (booking_id, room_type_id)
);
create index if not exists booking_rooms_type_idx on public.booking_rooms (room_type_id);

-- Every change, with what it was before and after (never a guest's name,
-- email or phone, so the yearly erasure leaves nothing behind here).
create table if not exists public.booking_changes (
    id                  text primary key default public.ztims_new_id(),
    booking_id          text not null references public.bookings (id),
    action              text not null,
    before              jsonb,
    after               jsonb,
    by_email            text not null default '',
    at                  timestamptz not null default now()
);
create index if not exists booking_changes_booking_idx on public.booking_changes (booking_id, at);

-- Money the guest paid the resort directly, as the manager records it.
create table if not exists public.booking_payments (
    id                  text primary key default public.ztims_new_id(),
    booking_id          text not null references public.bookings (id),
    amount              numeric(12, 2) not null constraint booking_payments_amount check (amount > 0 and amount <= 10000000),
    method              text not null
                        constraint booking_payments_method check (method in ('cash', 'gcash', 'maya', 'bank', 'card', 'other')),
    received_on         date not null,
    reference           text not null default '' constraint booking_payments_reference_length check (char_length(reference) <= 120),
    recorded_by_email   text not null default '',
    created_at          timestamptz not null default now()
);
create index if not exists booking_payments_booking_idx on public.booking_payments (booking_id);

-- A Guest Register stay made from a booking at check-in (one per booking).
alter table public.register_entries add column if not exists booking_id text references public.bookings (id);
create unique index if not exists register_entries_booking_idx on public.register_entries (booking_id) where booking_id is not null;


-- ---------------------------------------------------------------------------
-- Visitor accounts (decided 9 November 2026, the panelist's request;
-- visitors.js). A visitor signs in with email and password or Google to buy
-- tickets and book rooms, keep saved places and write reviews. The role in
-- their tokens is 'tourist'. The account stays until the visitor deletes it;
-- deleting erases the name, phone, email, password and Google id, and keeps
-- the row so their old tickets, bookings and reviews still point somewhere.
-- ---------------------------------------------------------------------------
create table if not exists public.visitors (
    id                  text primary key default public.ztims_new_id(),
    -- Null only once the account is deleted.
    email               text
                        constraint visitors_email_normalised
                        check (email is null or (email <> '' and email = lower(btrim(email)) and char_length(email) <= 254)),
    email_verified_at   timestamptz,
    -- Null for an account that signs in with Google only.
    password_hash       text,
    google_sub          text,
    full_name           text not null default ''
                        constraint visitors_full_name_length check (char_length(full_name) <= 120),
    phone               text not null default ''
                        constraint visitors_phone_length check (char_length(phone) <= 40),
    country_code        text references public.residences (code),
    session_version     integer not null default 0,
    status              text not null default 'active'
                        constraint visitors_status_known check (status in ('active', 'suspended', 'deleted')),
    last_sign_in_at     timestamptz,
    deleted_at          timestamptz,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);
create unique index if not exists visitors_email_unique on public.visitors (lower(email)) where email is not null;
create unique index if not exists visitors_google_sub_unique on public.visitors (google_sub) where google_sub is not null;

-- Email links: only a hash is kept; each is used once and runs out.
create table if not exists public.visitor_tokens (
    id                  text primary key default public.ztims_new_id(),
    visitor_id          text not null references public.visitors (id),
    purpose             text not null constraint visitor_tokens_purpose_known check (purpose in ('verify', 'reset')),
    token_hash          text not null unique,
    expires_at          timestamptz not null,
    used_at             timestamptz,
    created_at          timestamptz not null default now()
);
create index if not exists visitor_tokens_visitor_idx on public.visitor_tokens (visitor_id, purpose);

create table if not exists public.saved_places (
    visitor_id          text not null references public.visitors (id),
    spot_id             text not null references public.spots (id),
    created_at          timestamptz not null default now(),
    primary key (visitor_id, spot_id)
);
create index if not exists saved_places_spot_idx on public.saved_places (spot_id);

-- One review per visitor per place, only after a used ticket or a completed
-- stay there (the ticket or booking is kept as the proof). The Tourism
-- Officer may hide one, with a reason. A deleted account's reviews stay,
-- shown as "Former visitor".
create table if not exists public.reviews (
    id                  text primary key default public.ztims_new_id(),
    visitor_id          text not null references public.visitors (id),
    spot_id             text not null references public.spots (id),
    rating              integer not null constraint reviews_rating_range check (rating between 1 and 5),
    body                text not null default '' constraint reviews_body_length check (char_length(body) <= 600),
    status              text not null default 'visible' constraint reviews_status_known check (status in ('visible', 'hidden')),
    hidden_reason       text not null default '' constraint reviews_hidden_reason_length check (char_length(hidden_reason) <= 300),
    hidden_by_email     text not null default '',
    hidden_at           timestamptz,
    ticket_id           text references public.tickets (id),
    booking_id          text references public.bookings (id),
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    constraint reviews_one_per_place unique (visitor_id, spot_id),
    constraint reviews_has_proof check (ticket_id is not null or booking_id is not null)
);
create index if not exists reviews_spot_idx on public.reviews (spot_id, status);

-- Every hide and show of a review by the Tourism Officer, with the reason
-- (required both ways). Goes with the review if its author deletes it.
create table if not exists public.review_changes (
    id                  text primary key default public.ztims_new_id(),
    review_id           text not null references public.reviews (id) on delete cascade,
    action              text not null constraint review_changes_action_known check (action in ('hidden', 'shown')),
    reason              text not null constraint review_changes_reason_length check (char_length(reason) between 3 and 300),
    by_email            text not null default '',
    at                  timestamptz not null default now()
);
create index if not exists review_changes_review_idx on public.review_changes (review_id, at);

-- Whose ticket or booking it is, once bought signed in or linked by email.
alter table public.tickets add column if not exists visitor_id text references public.visitors (id);
alter table public.bookings add column if not exists visitor_id text references public.visitors (id);
create index if not exists tickets_visitor_idx on public.tickets (visitor_id) where visitor_id is not null;
create index if not exists bookings_visitor_idx on public.bookings (visitor_id) where visitor_id is not null;


-- ---------------------------------------------------------------------------
-- Support Staff (9 November 2026): a person of the Municipal Tourism Office
-- who looks after one attraction the office runs (no manager) whose "Count
-- visitors here" is on: its Guest Register, its monthly report and its
-- listing details except category and prices. Created by the Tourism Officer;
-- deactivated, never deleted. One active account per attraction. Signs in on
-- the staff sign-in page like the officer (role 'support_staff' in tokens).
-- ---------------------------------------------------------------------------
create table if not exists public.support_staff (
    id                   text primary key default public.ztims_new_id(),
    email                text not null
                         constraint support_staff_email_normalised
                         check (email <> '' and email = lower(btrim(email))),
    password_hash        text not null,
    -- Password reset: only the token's SHA-256 is ever stored.
    reset_token_hash     text,
    reset_token_expires  timestamptz,
    full_name            text not null constraint support_staff_full_name_length check (char_length(btrim(full_name)) between 1 and 120),
    position             text not null default '' constraint support_staff_position_length check (char_length(position) <= 120),
    contact_number       text not null default '' constraint support_staff_contact_length check (char_length(contact_number) <= 40),
    spot_id              text not null references public.spots (id),
    status               text not null default 'active' constraint support_staff_status_known check (status in ('active', 'inactive')),
    must_change_password boolean not null default true,
    session_version      integer not null default 0,
    last_sign_in_at      timestamptz,
    created_by_email     text not null default '',
    created_at           timestamptz not null default now(),
    updated_at           timestamptz not null default now()
);
create unique index if not exists support_staff_email_unique on public.support_staff (lower(email));
-- One active account per attraction; a replaced person's account stays, inactive.
create unique index if not exists support_staff_one_active_per_spot on public.support_staff (spot_id) where status = 'active';



-- ---------------------------------------------------------------------------
-- updated_at triggers, and Row Level Security on, with no policies, for all.
-- ---------------------------------------------------------------------------
do $$
declare
    t text;
begin
    foreach t in array array[
        'tourism_officers', 'establishment_managers', 'spots', 'payments', 'feedback',
        'monthly_reports', 'tickets', 'online_checkouts', 'spot_closed_dates',
        'emergency_numbers', 'register_entries', 'announcements',
        'enterprise_booking_settings', 'room_types', 'room_blocks', 'bookings',
        'visitors', 'reviews', 'support_staff'
    ] loop
        execute format('drop trigger if exists %I on public.%I', t || '_touch_updated_at', t);
        execute format(
            'create trigger %I before update on public.%I for each row execute function public.ztims_touch_updated_at()',
            t || '_touch_updated_at', t
        );
    end loop;

    foreach t in array array[
        'tourism_officers', 'establishment_managers', 'spots', 'payments', 'feedback', 'rate_limits',
        'residences', 'monthly_reports', 'monthly_report_counts', 'report_changes',
        'tickets', 'online_checkouts', 'spot_closed_dates', 'spot_photos', 'spot_more_categories',
        'office_info', 'emergency_numbers', 'register_entries', 'register_entry_guests', 'announcements',
        'enterprise_booking_settings', 'room_types', 'room_blocks', 'bookings', 'booking_rooms',
        'booking_changes', 'booking_payments', 'visitors', 'visitor_tokens', 'saved_places', 'reviews', 'review_changes', 'support_staff'
    ] loop
        execute format('alter table public.%I enable row level security', t);
    end loop;
end
$$;


-- ---------------------------------------------------------------------------
-- Tour guides taken out (October 2026, the user's decision): no guide
-- accounts, no guide bookings, no "tourist guide required" on a listing.
-- Their records are deleted with them — guides, their destinations and
-- languages, their reports, the guide bookings, and the payments and online
-- checkouts made for those bookings. Tickets and their payments stay.
-- Nothing left to do on a database that has already been through this.
-- ---------------------------------------------------------------------------
do $$
begin
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'online_checkouts' and column_name = 'booking_id') then
        delete from public.online_checkouts where booking_id is not null;
        -- Takes the generated "kind" and the one-or-the-other rule with it.
        alter table public.online_checkouts drop column booking_id cascade;
        alter table public.online_checkouts alter column ticket_id set not null;
    end if;
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'payments' and column_name = 'booking_id') then
        delete from public.payments where booking_id is not null;
        alter table public.payments drop column booking_id cascade;
        alter table public.payments alter column ticket_id set not null;
    end if;
end
$$;

drop table if exists public.guide_reports;
drop table if exists public.guide_languages;
drop table if exists public.languages;
drop table if exists public.tourist_guide_spots;
drop table if exists public.guide_bookings;
drop table if exists public.tourist_guides;
drop table if exists public.guide_time_off;
drop table if exists public.guide_profile_requests;
alter table public.spots drop column if exists requires_guide;


-- ---------------------------------------------------------------------------
-- One manager, many enterprises (November 2026, the panelist's request). The
-- account is the person; each listing is an enterprise with its own name,
-- phone and public email. The one-listing limit goes, and the enterprise's
-- details copy across from the account once (only while a listing's is blank).
-- The account keeps the person's name and phone; its contact_email is the
-- fallback when an enterprise has no public email of its own, and its
-- establishment_name stays, unused, as the record of what it was.
-- ---------------------------------------------------------------------------
alter table public.spots add column if not exists enterprise_name text not null default '';
alter table public.spots add column if not exists phone text not null default '';
alter table public.spots add column if not exists contact_email text not null default '';

update public.spots s
   set enterprise_name = m.establishment_name,
       phone = m.phone,
       contact_email = m.contact_email
  from public.establishment_managers m
 where m.id = s.managed_by and s.enterprise_name = '';

drop index if exists public.spots_one_per_establishment;

-- An account no longer has to name an enterprise.
alter table public.establishment_managers drop constraint if exists establishment_managers_name_required;
alter table public.establishment_managers alter column establishment_name set default '';
alter table public.establishment_managers alter column establishment_name drop not null;


-- ---------------------------------------------------------------------------
-- Count visitors here (November 2026). Visitor counting applies to places that
-- receive and record visitors: a statue or a marker the office keeps has
-- nothing to count, and switched off it leaves Statistics (the Tracker, Enter
-- a report, the Guest Register, Form A4's places) while staying on the site
-- and the map. Only the officer sets it, only for office-run places; a private
-- enterprise always counts. Every existing place keeps counting.
-- ---------------------------------------------------------------------------
alter table public.spots add column if not exists counts_visitors boolean not null default true;


-- ---------------------------------------------------------------------------
-- Support Staff and counting (after counts_visitors above).
-- ---------------------------------------------------------------------------
-- 10 November 2026 (the user's decision): an office place counts visitors
-- only through its Support Staff; adding someone switches counting on. Once,
-- before any Support Staff account exists, office places (attractions and
-- places to stay) with nobody assigned and no records are switched off.
-- Places with a report or register entry stay on. Nothing is deleted, and
-- later runs (Support Staff exist by then) change nothing.
do $$
begin
    if not exists (select 1 from public.support_staff) then
        update public.spots s set counts_visitors = false
         where s.managed_by is null and s.counts_visitors
           and not exists (select 1 from public.monthly_reports r where r.spot_id = s.id and r.status <> 'void')
           and not exists (select 1 from public.register_entries e where e.spot_id = s.id);
    end if;
end $$;


-- ===========================================================================
-- Accommodation reporting (November 2026, stage 2). One record of each stay
-- at a private place to stay; the DAE-1A, DAE-1B and FORM A are worked out
-- from it. Attractions keep monthly_reports and the Guest Register above.
--
--   accommodation_profiles             the DAE-1B header facts, reporting start
--   accommodation_rooms                numbered rooms, dated availability
--   accommodation_room_unavailability  a room out of service, inclusive dates
--   accommodation_closed_periods       the place not operating, inclusive dates
--   accommodation_stays                one stay: check-in, check-out
--   accommodation_stay_rooms           which room, which nights [starts, ends)
--   accommodation_stay_guests          guests by residence, male / female, the
--                                      nights they are there [starts, ends):
--                                      a guest joining later is a dated row
--   accommodation_report_versions      a submitted month, never changed
--   accommodation_report_version_counts  its Part I counts
--   accommodation_periods              a month finalized by the officer
--   accommodation_period_events        submitted / finalized / reopened, who,
--                                      when, why
--   accommodation_changes              every change to the records above
--
-- Nights: the night of date D is held when starts_on <= D < ends_on. The
-- check-out night is never a night of the stay. A finalized month refuses any
-- change that would alter it (accommodation_assert_open); saved versions and
-- events refuse every update and delete. Nothing here holds a guest's name,
-- contact or ID. 2025's municipal totals stay in monthly_reports, untouched,
-- and a month holding one refuses enterprise versions (and the reverse).
-- ===========================================================================
create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

create table if not exists public.accommodation_profiles (
    spot_id             text primary key references public.spots (id),
    accommodation_type  text not null default ''
                        constraint accommodation_profiles_type
                        check (accommodation_type in ('', 'hotel', 'resort', 'pension', 'hostel', 'apartel', 'other')),
    accommodation_type_other text not null default ''
                        constraint accommodation_profiles_type_other check (char_length(accommodation_type_other) <= 80),
    dot_classification  text not null default ''
                        constraint accommodation_profiles_dot check (char_length(dot_classification) <= 80),
    ae_code             text not null default ''
                        constraint accommodation_profiles_ae_code check (char_length(ae_code) <= 40),
    -- First day of the first month this enterprise reports in ZTIMS.
    reporting_from      date constraint accommodation_profiles_from check (reporting_from is null or extract(day from reporting_from) = 1),
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create table if not exists public.accommodation_rooms (
    id                  text primary key default public.ztims_new_id(),
    spot_id             text not null references public.spots (id),
    room_number         text not null constraint accommodation_rooms_number check (char_length(btrim(room_number)) between 1 and 20),
    room_type_id        text references public.room_types (id),
    label               text not null default '' constraint accommodation_rooms_label check (char_length(label) <= 80),
    sleeps              integer not null constraint accommodation_rooms_sleeps check (sleeps between 1 and 30),
    -- A shared room (a dormitory) may hold several stays on one night; it is
    -- still one room-night occupied.
    shared              boolean not null default false,
    available_from      date not null,
    available_until     date,               -- first day no longer available
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    constraint accommodation_rooms_dates check (available_until is null or available_until > available_from)
);
create unique index if not exists accommodation_rooms_number_idx on public.accommodation_rooms (spot_id, lower(btrim(room_number)));

create table if not exists public.accommodation_room_unavailability (
    id                  text primary key default public.ztims_new_id(),
    spot_id             text not null references public.spots (id),
    room_id             text not null references public.accommodation_rooms (id),
    starts_on           date not null,
    ends_on             date not null,      -- inclusive
    reason              text not null constraint accommodation_unavail_reason check (char_length(btrim(reason)) between 1 and 200),
    voided_at           timestamptz,
    void_reason         text not null default '' constraint accommodation_unavail_void check (char_length(void_reason) <= 300),
    created_by_email    text not null default '',
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    constraint accommodation_unavail_dates check (ends_on >= starts_on)
);
create index if not exists accommodation_unavail_room_idx on public.accommodation_room_unavailability (room_id, starts_on);

create table if not exists public.accommodation_closed_periods (
    id                  text primary key default public.ztims_new_id(),
    spot_id             text not null references public.spots (id),
    starts_on           date not null,
    ends_on             date not null,      -- inclusive
    reason              text not null constraint accommodation_closed_reason check (char_length(btrim(reason)) between 1 and 200),
    voided_at           timestamptz,
    void_reason         text not null default '' constraint accommodation_closed_void check (char_length(void_reason) <= 300),
    created_by_email    text not null default '',
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    constraint accommodation_closed_dates check (ends_on >= starts_on)
);
create index if not exists accommodation_closed_spot_idx on public.accommodation_closed_periods (spot_id, starts_on);

create table if not exists public.accommodation_stays (
    id                  text primary key default public.ztims_new_id(),
    spot_id             text not null references public.spots (id),
    reference           text not null constraint accommodation_stays_reference check (char_length(reference) between 1 and 20),
    check_in            date not null,
    check_out           date not null,
    status              text not null default 'active' constraint accommodation_stays_status check (status in ('active', 'void')),
    void_reason         text not null default '' constraint accommodation_stays_void check (char_length(void_reason) <= 300),
    -- A booking may start a stay; the booking itself is never a count.
    booking_id          text references public.bookings (id),
    -- Raised on every change: an edit must name the revision it read.
    revision            integer not null default 1,
    created_by_email    text not null default '',
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    constraint accommodation_stays_dates check (check_out > check_in and check_out - check_in <= 366)
);
create unique index if not exists accommodation_stays_reference_idx on public.accommodation_stays (spot_id, reference);
create unique index if not exists accommodation_stays_booking_idx on public.accommodation_stays (booking_id) where booking_id is not null;
create index if not exists accommodation_stays_dates_idx on public.accommodation_stays (spot_id, check_in, check_out);

create table if not exists public.accommodation_stay_rooms (
    id                  text primary key default public.ztims_new_id(),
    stay_id             text not null references public.accommodation_stays (id) on delete cascade,
    room_id             text not null references public.accommodation_rooms (id),
    starts_on           date not null,
    ends_on             date not null,      -- the morning they leave the room
    -- Kept in step by triggers: the stay's status and the room's sharing.
    active              boolean not null default true,
    shared              boolean not null default false,
    nights              daterange generated always as (daterange(starts_on, ends_on, '[)')) stored,
    constraint accommodation_stay_rooms_dates check (ends_on > starts_on)
);
create index if not exists accommodation_stay_rooms_stay_idx on public.accommodation_stay_rooms (stay_id);
do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'accommodation_stay_rooms_no_double_booking') then
        alter table public.accommodation_stay_rooms add constraint accommodation_stay_rooms_no_double_booking
            exclude using gist (room_id with =, nights with &&) where (active and not shared);
    end if;
end $$;

create table if not exists public.accommodation_stay_guests (
    id                  text primary key default public.ztims_new_id(),
    stay_id             text not null references public.accommodation_stays (id) on delete cascade,
    residence_code      text not null references public.residences (code),
    male                integer not null default 0 constraint accommodation_stay_guests_male check (male between 0 and 999),
    female              integer not null default 0 constraint accommodation_stay_guests_female check (female between 0 and 999),
    starts_on           date not null,      -- the day they arrive: counted as arrivals that day
    ends_on             date not null,      -- the day they leave
    constraint accommodation_stay_guests_someone check (male + female > 0),
    constraint accommodation_stay_guests_dates check (ends_on > starts_on)
);
create index if not exists accommodation_stay_guests_stay_idx on public.accommodation_stay_guests (stay_id);

create table if not exists public.accommodation_report_versions (
    id                  text primary key default public.ztims_new_id(),
    spot_id             text not null references public.spots (id),
    year                integer not null constraint accommodation_versions_year check (year between 2000 and 2100),
    month               integer not null constraint accommodation_versions_month check (month between 1 and 12),
    version             integer not null constraint accommodation_versions_version check (version >= 1),
    -- 'register': worked out from the stays (source_digest fingerprints them).
    -- 'legacy_manual': a monthly report typed by hand before this model,
    -- copied as it was; no stays stand behind it.
    provenance          text not null constraint accommodation_versions_provenance check (provenance in ('register', 'legacy_manual')),
    legacy_report_id    text references public.monthly_reports (id),
    rooms               integer not null constraint accommodation_versions_rooms check (rooms >= 0),
    room_nights_available integer not null constraint accommodation_versions_available check (room_nights_available >= 0),
    room_nights_occupied integer not null constraint accommodation_versions_occupied check (room_nights_occupied >= 0),
    guest_nights        integer not null constraint accommodation_versions_guest_nights check (guest_nights >= 0),
    arrivals            integer not null constraint accommodation_versions_arrivals check (arrivals >= 0),
    source_digest       text not null default '',
    source_stays        integer not null default 0,
    reason              text not null default '' constraint accommodation_versions_reason check (char_length(reason) <= 300),
    late                boolean not null default false,
    submitted_by_role   text not null default '',
    submitted_by_email  text not null default '',
    submitted_at        timestamptz not null default now(),
    constraint accommodation_versions_fit check (room_nights_occupied <= room_nights_available),
    constraint accommodation_versions_legacy check ((provenance = 'legacy_manual') = (legacy_report_id is not null))
);
create unique index if not exists accommodation_versions_number_idx on public.accommodation_report_versions (spot_id, year, month, version);
-- The version's day-by-day detail (arrivals per day by residence and sex; each
-- day's DAE-1A columns, rooms occupied by number): its exports come from it.
-- Null for a legacy_manual version, which has no days.
alter table public.accommodation_report_versions add column if not exists detail jsonb;
create unique index if not exists accommodation_versions_legacy_idx on public.accommodation_report_versions (legacy_report_id) where legacy_report_id is not null;
create index if not exists accommodation_versions_period_idx on public.accommodation_report_versions (year, month);

create table if not exists public.accommodation_report_version_counts (
    version_id          text not null references public.accommodation_report_versions (id),
    residence_code      text not null references public.residences (code),
    male                integer not null constraint accommodation_version_counts_male check (male >= 0),
    female              integer not null constraint accommodation_version_counts_female check (female >= 0),
    total               integer generated always as (male + female) stored,
    primary key (version_id, residence_code),
    constraint accommodation_version_counts_someone check (male + female > 0)
);

create table if not exists public.accommodation_periods (
    spot_id             text not null references public.spots (id),
    year                integer not null,
    month               integer not null constraint accommodation_periods_month check (month between 1 and 12),
    finalized_at        timestamptz,
    finalized_by_email  text not null default '',
    finalized_version_id text references public.accommodation_report_versions (id),
    updated_at          timestamptz not null default now(),
    primary key (spot_id, year, month),
    constraint accommodation_periods_final check ((finalized_at is null) = (finalized_version_id is null))
);

create table if not exists public.accommodation_period_events (
    id                  text primary key default public.ztims_new_id(),
    spot_id             text not null references public.spots (id),
    year                integer not null,
    month               integer not null,
    action              text not null constraint accommodation_events_action check (action in ('submitted', 'finalized', 'reopened')),
    version_id          text references public.accommodation_report_versions (id),
    reason              text not null default '' constraint accommodation_events_reason check (char_length(reason) <= 300),
    actor_role          text not null default '',
    actor_email         text not null default '',
    at                  timestamptz not null default now(),
    constraint accommodation_events_reopen_reason check (action <> 'reopened' or char_length(btrim(reason)) >= 10)
);
create index if not exists accommodation_events_period_idx on public.accommodation_period_events (spot_id, year, month, at);

create table if not exists public.accommodation_changes (
    id                  text primary key default public.ztims_new_id(),
    spot_id             text not null references public.spots (id),
    entity              text not null constraint accommodation_changes_entity
                        check (entity in ('profile', 'room', 'unavailability', 'closed_period', 'stay')),
    entity_id           text not null,
    action              text not null constraint accommodation_changes_action
                        check (action in ('created', 'edited', 'voided')),
    reason              text not null default '' constraint accommodation_changes_reason check (char_length(reason) <= 300),
    -- Every month whose figures the change can alter, 'YYYY-MM'.
    affected_months     text[] not null default '{}',
    before              jsonb,
    after               jsonb,
    actor_role          text not null default '',
    actor_email         text not null default '',
    at                  timestamptz not null default now()
);
create index if not exists accommodation_changes_entity_idx on public.accommodation_changes (entity, entity_id, at);
create index if not exists accommodation_changes_spot_idx on public.accommodation_changes (spot_id, at);

-- ---- Rules the database holds ------------------------------------------------

-- Refuses a change touching a finalized month of this place. `to_day` is the
-- last day the change reaches (inclusive); null means "from from_day on".
create or replace function public.accommodation_assert_open(p_spot text, from_day date, to_day date)
returns void language plpgsql set search_path = '' as $$
declare hit record;
begin
    select year, month into hit from public.accommodation_periods p
     where p.spot_id = p_spot and p.finalized_at is not null
       and make_date(p.year, p.month, 1) <= coalesce(date_trunc('month', to_day)::date, 'infinity'::date)
       and make_date(p.year, p.month, 1) >= date_trunc('month', from_day)::date
     order by year, month limit 1;
    if found then
        raise exception 'PERIOD_FINALIZED %-%', hit.year, lpad(hit.month::text, 2, '0') using errcode = 'P0001';
    end if;
end $$;

-- Only private places to stay keep these records.
create or replace function public.accommodation_assert_place(p_spot text)
returns void language plpgsql set search_path = '' as $$
begin
    if not exists (select 1 from public.spots s where s.id = p_spot and s.type = 'accommodation' and s.managed_by is not null) then
        raise exception 'NOT_ACCOMMODATION %', p_spot using errcode = 'P0001';
    end if;
end $$;

create or replace function public.accommodation_guard_rows()
returns trigger language plpgsql set search_path = '' as $$
declare r record; s record;
begin
    if tg_table_name = 'accommodation_profiles' then
        perform public.accommodation_assert_place(new.spot_id);
        if tg_op = 'UPDATE' and new.reporting_from is distinct from old.reporting_from then
            perform public.accommodation_assert_open(new.spot_id, least(coalesce(old.reporting_from, new.reporting_from), coalesce(new.reporting_from, old.reporting_from)), null);
        end if;
        return new;
    elsif tg_table_name = 'accommodation_rooms' then
        if tg_op = 'INSERT' then
            perform public.accommodation_assert_place(new.spot_id);
            perform public.accommodation_assert_open(new.spot_id, new.available_from, null);
            if new.room_type_id is not null and not exists (select 1 from public.room_types t where t.id = new.room_type_id and t.spot_id = new.spot_id) then
                raise exception 'ROOM_TYPE_OTHER_PLACE' using errcode = 'P0001';
            end if;
            return new;
        end if;
        if tg_op = 'DELETE' then raise exception 'NO_DELETE' using errcode = 'P0001'; end if;
        if new.spot_id <> old.spot_id then raise exception 'ROOM_MOVED' using errcode = 'P0001'; end if;
        if new.available_from <> old.available_from then
            perform public.accommodation_assert_open(new.spot_id, least(new.available_from, old.available_from), greatest(new.available_from, old.available_from));
        end if;
        if new.available_until is distinct from old.available_until then
            perform public.accommodation_assert_open(new.spot_id, least(coalesce(new.available_until, old.available_until), coalesce(old.available_until, new.available_until)),
                case when new.available_until is null or old.available_until is null then null else greatest(new.available_until, old.available_until) end);
        end if;
        if new.shared <> old.shared and exists (select 1 from public.accommodation_stay_rooms a where a.room_id = new.id) then
            raise exception 'ROOM_SHARING_FIXED' using errcode = 'P0001';
        end if;
        return new;
    elsif tg_table_name in ('accommodation_room_unavailability', 'accommodation_closed_periods') then
        if tg_op = 'DELETE' then raise exception 'NO_DELETE' using errcode = 'P0001'; end if;
        if tg_op = 'INSERT' then
            perform public.accommodation_assert_place(new.spot_id);
            perform public.accommodation_assert_open(new.spot_id, new.starts_on, new.ends_on);
            if tg_table_name = 'accommodation_room_unavailability' then
                if not exists (select 1 from public.accommodation_rooms x where x.id = to_jsonb(new) ->> 'room_id' and x.spot_id = new.spot_id) then
                    raise exception 'ROOM_OTHER_PLACE' using errcode = 'P0001';
                end if;
            end if;
            return new;
        end if;
        -- Only voiding: dates, room and place never change.
        if (new.starts_on, new.ends_on, new.spot_id) is distinct from (old.starts_on, old.ends_on, old.spot_id)
           or (old.voided_at is not null) then
            raise exception 'ONLY_VOID' using errcode = 'P0001';
        end if;
        perform public.accommodation_assert_open(new.spot_id, new.starts_on, new.ends_on);
        return new;
    elsif tg_table_name = 'accommodation_stays' then
        if tg_op = 'DELETE' then raise exception 'NO_DELETE' using errcode = 'P0001'; end if;
        if tg_op = 'INSERT' then
            perform public.accommodation_assert_place(new.spot_id);
            perform public.accommodation_assert_open(new.spot_id, new.check_in, new.check_out - 1);
            return new;
        end if;
        if new.spot_id <> old.spot_id then raise exception 'STAY_MOVED' using errcode = 'P0001'; end if;
        if old.status = 'void' then raise exception 'STAY_VOID' using errcode = 'P0001'; end if;
        perform public.accommodation_assert_open(old.spot_id, old.check_in, old.check_out - 1);
        perform public.accommodation_assert_open(new.spot_id, new.check_in, new.check_out - 1);
        new.revision := old.revision + 1;
        return new;
    elsif tg_table_name in ('accommodation_stay_rooms', 'accommodation_stay_guests') then
        if tg_op in ('UPDATE', 'DELETE') then
            select * into s from public.accommodation_stays where id = old.stay_id;
            if s.id is not null then perform public.accommodation_assert_open(s.spot_id, old.starts_on, old.ends_on - 1); end if;
        end if;
        if tg_op = 'DELETE' then return old; end if;
        select * into s from public.accommodation_stays where id = new.stay_id;
        perform public.accommodation_assert_open(s.spot_id, new.starts_on, new.ends_on - 1);
        if tg_table_name = 'accommodation_stay_rooms' then
            select * into r from public.accommodation_rooms where id = new.room_id;
            if r.spot_id is distinct from s.spot_id then raise exception 'ROOM_OTHER_PLACE' using errcode = 'P0001'; end if;
            new.shared := r.shared;
            new.active := (s.status = 'active');
        end if;
        return new;
    end if;
    return new;
end $$;

-- After every statement that touches a stay, checked at commit: the stay's
-- rooms and guests fit together and fit the place.
create or replace function public.accommodation_check_stay()
returns trigger language plpgsql set search_path = '' as $$
declare sid text; s record; d date; bad text;
begin
    if tg_table_name = 'accommodation_stays' then
        sid := case when tg_op = 'DELETE' then old.id else new.id end;
    else
        sid := case when tg_op = 'DELETE' then old.stay_id else new.stay_id end;
    end if;
    select * into s from public.accommodation_stays where id = sid;
    if s.id is null or s.status <> 'active' then return null; end if;
    -- Rooms: inside the stay, this place's, available, not out of service, not closed, not twice in one stay.
    select a.id into bad from public.accommodation_stay_rooms a join public.accommodation_rooms r on r.id = a.room_id
     where a.stay_id = sid and (a.starts_on < s.check_in or a.ends_on > s.check_out or r.spot_id <> s.spot_id
           or a.starts_on < r.available_from or (r.available_until is not null and a.ends_on > r.available_until)) limit 1;
    if bad is not null then raise exception 'STAY_ROOM_OUTSIDE %', s.reference using errcode = 'P0001'; end if;
    if exists (select 1 from public.accommodation_stay_rooms a join public.accommodation_stay_rooms b
                 on b.stay_id = a.stay_id and b.room_id = a.room_id and b.id < a.id and b.nights && a.nights
                where a.stay_id = sid) then
        raise exception 'STAY_ROOM_TWICE %', s.reference using errcode = 'P0001';
    end if;
    if exists (select 1 from public.accommodation_stay_rooms a join public.accommodation_room_unavailability u
                 on u.room_id = a.room_id and u.voided_at is null and u.starts_on < a.ends_on and u.ends_on >= a.starts_on
                where a.stay_id = sid) then
        raise exception 'ROOM_OUT_OF_SERVICE %', s.reference using errcode = 'P0001';
    end if;
    if exists (select 1 from public.accommodation_closed_periods c
                where c.spot_id = s.spot_id and c.voided_at is null and c.starts_on < s.check_out and c.ends_on >= s.check_in) then
        raise exception 'PLACE_CLOSED %', s.reference using errcode = 'P0001';
    end if;
    -- Guests: inside the stay, someone arrives at check-in and leaves at check-out.
    if exists (select 1 from public.accommodation_stay_guests g where g.stay_id = sid and (g.starts_on < s.check_in or g.ends_on > s.check_out))
       or not exists (select 1 from public.accommodation_stay_guests g where g.stay_id = sid and g.starts_on = s.check_in)
       or not exists (select 1 from public.accommodation_stay_guests g where g.stay_id = sid and g.ends_on = s.check_out) then
        raise exception 'STAY_GUEST_DATES %', s.reference using errcode = 'P0001';
    end if;
    -- Every night has a room and a guest.
    for d in select generate_series(s.check_in, s.check_out - 1, interval '1 day')::date loop
        if not exists (select 1 from public.accommodation_stay_rooms a where a.stay_id = sid and a.starts_on <= d and d < a.ends_on) then
            raise exception 'NIGHT_WITHOUT_ROOM % %', s.reference, d using errcode = 'P0001';
        end if;
        if not exists (select 1 from public.accommodation_stay_guests g where g.stay_id = sid and g.starts_on <= d and d < g.ends_on) then
            raise exception 'NIGHT_WITHOUT_GUEST % %', s.reference, d using errcode = 'P0001';
        end if;
    end loop;
    return null;
end $$;

-- Stay status follows onto its room rows, so a voided stay frees its rooms.
create or replace function public.accommodation_stay_status_follow()
returns trigger language plpgsql set search_path = '' as $$
begin
    if new.status is distinct from old.status then
        update public.accommodation_stay_rooms set active = (new.status = 'active') where stay_id = new.id;
    end if;
    return null;
end $$;

-- Saved versions, their counts and events are never changed or removed.
create or replace function public.accommodation_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
    raise exception 'IMMUTABLE %', tg_table_name using errcode = 'P0001';
end $$;

-- A new version: the month is not finalized and not a municipal-total month;
-- its numbers add up (checked at commit, after its counts are in).
create or replace function public.accommodation_version_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
    perform public.accommodation_assert_place(new.spot_id);
    if exists (select 1 from public.accommodation_periods p where p.spot_id = new.spot_id and p.year = new.year and p.month = new.month and p.finalized_at is not null) then
        raise exception 'PERIOD_FINALIZED %-%', new.year, lpad(new.month::text, 2, '0') using errcode = 'P0001';
    end if;
    if exists (select 1 from public.monthly_reports m where m.kind = 'municipal_total' and m.status = 'submitted' and m.year = new.year and m.month = new.month) then
        raise exception 'MUNICIPAL_TOTAL_MONTH %-%', new.year, lpad(new.month::text, 2, '0') using errcode = 'P0001';
    end if;
    if new.version > 1 and not exists (select 1 from public.accommodation_report_versions v
            where v.spot_id = new.spot_id and v.year = new.year and v.month = new.month and v.version = new.version - 1) then
        raise exception 'VERSION_GAP' using errcode = 'P0001';
    end if;
    return new;
end $$;

create or replace function public.accommodation_version_reconcile()
returns trigger language plpgsql set search_path = '' as $$
declare v record; n integer;
begin
    if tg_table_name = 'accommodation_report_versions' then
        select * into v from public.accommodation_report_versions where id = new.id;
    else
        select * into v from public.accommodation_report_versions where id = new.version_id;
    end if;
    select coalesce(sum(male + female), 0) into n from public.accommodation_report_version_counts where version_id = v.id;
    if n <> v.arrivals then
        raise exception 'COUNTS_DO_NOT_ADD_UP % %', n, v.arrivals using errcode = 'P0001';
    end if;
    return null;
end $$;

-- A municipal total may not be recorded for a month enterprises reported.
create or replace function public.accommodation_municipal_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
    if new.kind = 'municipal_total' and new.status = 'submitted'
       and exists (select 1 from public.accommodation_report_versions v where v.year = new.year and v.month = new.month) then
        raise exception 'ENTERPRISE_REPORTS_EXIST %-%', new.year, lpad(new.month::text, 2, '0') using errcode = 'P0001';
    end if;
    return new;
end $$;

-- A finalized period can only be reopened (finalized_at back to null), never moved.
create or replace function public.accommodation_period_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
    if tg_op = 'DELETE' then raise exception 'NO_DELETE' using errcode = 'P0001'; end if;
    perform public.accommodation_assert_place(new.spot_id);
    if new.finalized_version_id is not null and not exists (select 1 from public.accommodation_report_versions v
            where v.id = new.finalized_version_id and v.spot_id = new.spot_id and v.year = new.year and v.month = new.month) then
        raise exception 'VERSION_OTHER_PERIOD' using errcode = 'P0001';
    end if;
    return new;
end $$;

-- Live received these tables from an early draft whose checks had no names,
-- so Postgres named them <table>_check, <table>_check1, ... (12 November 2026).
-- A constraint trigger takes a name in the same list, so accommodation_stays_check
-- clashed with the trigger below. Give each draft check its name here: only
-- when the old name exists with exactly this definition and the new name is
-- free, so this does nothing on a database built from this file.
do $$
declare r record;
begin
    for r in select * from (values
        ('accommodation_changes', 'accommodation_changes_action_check', 'accommodation_changes_action', 'CHECK ((action = ANY (ARRAY[''created''::text, ''edited''::text, ''voided''::text])))'),
        ('accommodation_changes', 'accommodation_changes_entity_check', 'accommodation_changes_entity', 'CHECK ((entity = ANY (ARRAY[''profile''::text, ''room''::text, ''unavailability''::text, ''closed_period''::text, ''stay''::text])))'),
        ('accommodation_changes', 'accommodation_changes_reason_check', 'accommodation_changes_reason', 'CHECK ((char_length(reason) <= 300))'),
        ('accommodation_closed_periods', 'accommodation_closed_periods_check', 'accommodation_closed_dates', 'CHECK ((ends_on >= starts_on))'),
        ('accommodation_closed_periods', 'accommodation_closed_periods_reason_check', 'accommodation_closed_reason', 'CHECK (((char_length(btrim(reason)) >= 1) AND (char_length(btrim(reason)) <= 200)))'),
        ('accommodation_closed_periods', 'accommodation_closed_periods_void_reason_check', 'accommodation_closed_void', 'CHECK ((char_length(void_reason) <= 300))'),
        ('accommodation_period_events', 'accommodation_period_events_action_check', 'accommodation_events_action', 'CHECK ((action = ANY (ARRAY[''submitted''::text, ''finalized''::text, ''reopened''::text])))'),
        ('accommodation_period_events', 'accommodation_period_events_check', 'accommodation_events_reopen_reason', 'CHECK (((action <> ''reopened''::text) OR (char_length(btrim(reason)) >= 10)))'),
        ('accommodation_period_events', 'accommodation_period_events_reason_check', 'accommodation_events_reason', 'CHECK ((char_length(reason) <= 300))'),
        ('accommodation_periods', 'accommodation_periods_check', 'accommodation_periods_final', 'CHECK (((finalized_at IS NULL) = (finalized_version_id IS NULL)))'),
        ('accommodation_periods', 'accommodation_periods_month_check', 'accommodation_periods_month', 'CHECK (((month >= 1) AND (month <= 12)))'),
        ('accommodation_profiles', 'accommodation_profiles_accommodation_type_check', 'accommodation_profiles_type', 'CHECK ((accommodation_type = ANY (ARRAY[''''::text, ''hotel''::text, ''resort''::text, ''pension''::text, ''hostel''::text, ''apartel''::text, ''other''::text])))'),
        ('accommodation_profiles', 'accommodation_profiles_accommodation_type_other_check', 'accommodation_profiles_type_other', 'CHECK ((char_length(accommodation_type_other) <= 80))'),
        ('accommodation_profiles', 'accommodation_profiles_ae_code_check', 'accommodation_profiles_ae_code', 'CHECK ((char_length(ae_code) <= 40))'),
        ('accommodation_profiles', 'accommodation_profiles_dot_classification_check', 'accommodation_profiles_dot', 'CHECK ((char_length(dot_classification) <= 80))'),
        ('accommodation_profiles', 'accommodation_profiles_reporting_from_check', 'accommodation_profiles_from', 'CHECK (((reporting_from IS NULL) OR (EXTRACT(day FROM reporting_from) = (1)::numeric)))'),
        ('accommodation_report_version_counts', 'accommodation_report_version_counts_check', 'accommodation_version_counts_someone', 'CHECK (((male + female) > 0))'),
        ('accommodation_report_version_counts', 'accommodation_report_version_counts_female_check', 'accommodation_version_counts_female', 'CHECK ((female >= 0))'),
        ('accommodation_report_version_counts', 'accommodation_report_version_counts_male_check', 'accommodation_version_counts_male', 'CHECK ((male >= 0))'),
        ('accommodation_report_versions', 'accommodation_report_versions_arrivals_check', 'accommodation_versions_arrivals', 'CHECK ((arrivals >= 0))'),
        ('accommodation_report_versions', 'accommodation_report_versions_check', 'accommodation_versions_fit', 'CHECK ((room_nights_occupied <= room_nights_available))'),
        ('accommodation_report_versions', 'accommodation_report_versions_check1', 'accommodation_versions_legacy', 'CHECK (((provenance = ''legacy_manual''::text) = (legacy_report_id IS NOT NULL)))'),
        ('accommodation_report_versions', 'accommodation_report_versions_guest_nights_check', 'accommodation_versions_guest_nights', 'CHECK ((guest_nights >= 0))'),
        ('accommodation_report_versions', 'accommodation_report_versions_month_check', 'accommodation_versions_month', 'CHECK (((month >= 1) AND (month <= 12)))'),
        ('accommodation_report_versions', 'accommodation_report_versions_provenance_check', 'accommodation_versions_provenance', 'CHECK ((provenance = ANY (ARRAY[''register''::text, ''legacy_manual''::text])))'),
        ('accommodation_report_versions', 'accommodation_report_versions_reason_check', 'accommodation_versions_reason', 'CHECK ((char_length(reason) <= 300))'),
        ('accommodation_report_versions', 'accommodation_report_versions_room_nights_available_check', 'accommodation_versions_available', 'CHECK ((room_nights_available >= 0))'),
        ('accommodation_report_versions', 'accommodation_report_versions_room_nights_occupied_check', 'accommodation_versions_occupied', 'CHECK ((room_nights_occupied >= 0))'),
        ('accommodation_report_versions', 'accommodation_report_versions_rooms_check', 'accommodation_versions_rooms', 'CHECK ((rooms >= 0))'),
        ('accommodation_report_versions', 'accommodation_report_versions_version_check', 'accommodation_versions_version', 'CHECK ((version >= 1))'),
        ('accommodation_report_versions', 'accommodation_report_versions_year_check', 'accommodation_versions_year', 'CHECK (((year >= 2000) AND (year <= 2100)))'),
        ('accommodation_room_unavailability', 'accommodation_room_unavailability_check', 'accommodation_unavail_dates', 'CHECK ((ends_on >= starts_on))'),
        ('accommodation_room_unavailability', 'accommodation_room_unavailability_reason_check', 'accommodation_unavail_reason', 'CHECK (((char_length(btrim(reason)) >= 1) AND (char_length(btrim(reason)) <= 200)))'),
        ('accommodation_room_unavailability', 'accommodation_room_unavailability_void_reason_check', 'accommodation_unavail_void', 'CHECK ((char_length(void_reason) <= 300))'),
        ('accommodation_rooms', 'accommodation_rooms_check', 'accommodation_rooms_dates', 'CHECK (((available_until IS NULL) OR (available_until > available_from)))'),
        ('accommodation_rooms', 'accommodation_rooms_label_check', 'accommodation_rooms_label', 'CHECK ((char_length(label) <= 80))'),
        ('accommodation_rooms', 'accommodation_rooms_room_number_check', 'accommodation_rooms_number', 'CHECK (((char_length(btrim(room_number)) >= 1) AND (char_length(btrim(room_number)) <= 20)))'),
        ('accommodation_rooms', 'accommodation_rooms_sleeps_check', 'accommodation_rooms_sleeps', 'CHECK (((sleeps >= 1) AND (sleeps <= 30)))'),
        ('accommodation_stay_guests', 'accommodation_stay_guests_check', 'accommodation_stay_guests_someone', 'CHECK (((male + female) > 0))'),
        ('accommodation_stay_guests', 'accommodation_stay_guests_check1', 'accommodation_stay_guests_dates', 'CHECK ((ends_on > starts_on))'),
        ('accommodation_stay_guests', 'accommodation_stay_guests_female_check', 'accommodation_stay_guests_female', 'CHECK (((female >= 0) AND (female <= 999)))'),
        ('accommodation_stay_guests', 'accommodation_stay_guests_male_check', 'accommodation_stay_guests_male', 'CHECK (((male >= 0) AND (male <= 999)))'),
        ('accommodation_stay_rooms', 'accommodation_stay_rooms_check', 'accommodation_stay_rooms_dates', 'CHECK ((ends_on > starts_on))'),
        ('accommodation_stays', 'accommodation_stays_check', 'accommodation_stays_dates', 'CHECK (((check_out > check_in) AND ((check_out - check_in) <= 366)))'),
        ('accommodation_stays', 'accommodation_stays_reference_check', 'accommodation_stays_reference', 'CHECK (((char_length(reference) >= 1) AND (char_length(reference) <= 20)))'),
        ('accommodation_stays', 'accommodation_stays_status_check', 'accommodation_stays_status', 'CHECK ((status = ANY (ARRAY[''active''::text, ''void''::text])))'),
        ('accommodation_stays', 'accommodation_stays_void_reason_check', 'accommodation_stays_void', 'CHECK ((char_length(void_reason) <= 300))')
    ) as v(tbl, old_name, new_name, def) loop
        if exists (select 1 from pg_constraint c where c.conrelid = ('public.' || r.tbl)::regclass and c.conname = r.old_name
                     and c.contype = 'c' and pg_get_constraintdef(c.oid) = r.def)
           and not exists (select 1 from pg_constraint c where c.conrelid = ('public.' || r.tbl)::regclass and c.conname = r.new_name) then
            execute format('alter table public.%I rename constraint %I to %I', r.tbl, r.old_name, r.new_name);
        end if;
    end loop;
end $$;

do $$
declare t text;
begin
    foreach t in array array['accommodation_profiles', 'accommodation_rooms', 'accommodation_room_unavailability',
                              'accommodation_closed_periods', 'accommodation_stays', 'accommodation_stay_rooms', 'accommodation_stay_guests'] loop
        execute format('drop trigger if exists %I on public.%I', t || '_guard', t);
        execute format('create trigger %I before insert or update or delete on public.%I for each row execute function public.accommodation_guard_rows()', t || '_guard', t);
    end loop;
    foreach t in array array['accommodation_stays', 'accommodation_stay_rooms', 'accommodation_stay_guests'] loop
        execute format('drop trigger if exists %I on public.%I', t || '_check', t);       -- its earlier name
        execute format('drop trigger if exists %I on public.%I', t || '_integrity', t);
        execute format('create constraint trigger %I after insert or update or delete on public.%I deferrable initially deferred for each row execute function public.accommodation_check_stay()', t || '_integrity', t);
    end loop;
    drop trigger if exists accommodation_stays_status_follow on public.accommodation_stays;
    create trigger accommodation_stays_status_follow after update on public.accommodation_stays
        for each row execute function public.accommodation_stay_status_follow();
    foreach t in array array['accommodation_report_versions', 'accommodation_report_version_counts', 'accommodation_period_events', 'accommodation_changes'] loop
        execute format('drop trigger if exists %I on public.%I', t || '_immutable', t);
        execute format('create trigger %I before update or delete on public.%I for each row execute function public.accommodation_immutable()', t || '_immutable', t);
    end loop;
    drop trigger if exists accommodation_report_versions_guard on public.accommodation_report_versions;
    create trigger accommodation_report_versions_guard before insert on public.accommodation_report_versions
        for each row execute function public.accommodation_version_guard();
    drop trigger if exists accommodation_report_versions_reconcile on public.accommodation_report_versions;
    create constraint trigger accommodation_report_versions_reconcile after insert on public.accommodation_report_versions
        deferrable initially deferred for each row execute function public.accommodation_version_reconcile();
    drop trigger if exists accommodation_report_version_counts_reconcile on public.accommodation_report_version_counts;
    create constraint trigger accommodation_report_version_counts_reconcile after insert on public.accommodation_report_version_counts
        deferrable initially deferred for each row execute function public.accommodation_version_reconcile();
    drop trigger if exists monthly_reports_accommodation_guard on public.monthly_reports;
    create trigger monthly_reports_accommodation_guard before insert or update on public.monthly_reports
        for each row execute function public.accommodation_municipal_guard();
    drop trigger if exists accommodation_periods_guard on public.accommodation_periods;
    create trigger accommodation_periods_guard before insert or update or delete on public.accommodation_periods
        for each row execute function public.accommodation_period_guard();

    foreach t in array array['accommodation_profiles', 'accommodation_rooms', 'accommodation_room_unavailability',
                              'accommodation_closed_periods', 'accommodation_stays', 'accommodation_periods'] loop
        execute format('drop trigger if exists %I on public.%I', t || '_touch_updated_at', t);
        execute format('create trigger %I before update on public.%I for each row execute function public.ztims_touch_updated_at()', t || '_touch_updated_at', t);
    end loop;
    foreach t in array array['accommodation_profiles', 'accommodation_rooms', 'accommodation_room_unavailability',
                              'accommodation_closed_periods', 'accommodation_stays', 'accommodation_stay_rooms', 'accommodation_stay_guests',
                              'accommodation_report_versions', 'accommodation_report_version_counts', 'accommodation_periods',
                              'accommodation_period_events', 'accommodation_changes'] loop
        execute format('alter table public.%I enable row level security', t);
    end loop;
end $$;

-- ---- Backfill: hand-typed accommodation reports become version 1 ----------
-- A place to stay's monthly report typed before this model is copied as it
-- was (provenance 'legacy_manual': no stays stand behind it, nothing is
-- invented), its counts with it; a finalized one finalizes the period. Runs
-- once per report (legacy_report_id is unique); a void report is not copied.
-- Office-run places to stay and 2025's municipal totals are left as they are.
do $$
declare r record; vid text; n integer;
begin
    for r in select m.* from public.monthly_reports m join public.spots s on s.id = m.spot_id
              where m.kind = 'accommodation' and m.status = 'submitted' and s.managed_by is not null and s.type = 'accommodation'
                and not exists (select 1 from public.accommodation_report_versions v where v.legacy_report_id = m.id)
                and not exists (select 1 from public.accommodation_report_versions v where v.spot_id = m.spot_id and v.year = m.year and v.month = m.month)
                and not exists (select 1 from public.monthly_reports t where t.kind = 'municipal_total' and t.status = 'submitted' and t.year = m.year and t.month = m.month)
    loop
        select coalesce(sum(coalesce(male + female, total_unsplit)), 0) into n from public.monthly_report_counts where report_id = r.id;
        insert into public.accommodation_report_versions (spot_id, year, month, version, provenance, legacy_report_id, rooms,
                    room_nights_available, room_nights_occupied, guest_nights, arrivals, reason, late, submitted_by_role, submitted_by_email, submitted_at)
        values (r.spot_id, r.year, r.month, 1, 'legacy_manual', r.id, coalesce(r.rooms, 0),
                coalesce(r.rooms, 0) * extract(day from (make_date(r.year, r.month, 1) + interval '1 month' - interval '1 day'))::integer,
                coalesce(r.room_nights_occupied, 0), coalesce(r.guest_nights, 0), n, 'Copied from the hand-typed monthly report',
                r.submitted_at > (make_date(r.year, r.month, 1) + interval '1 month' + interval '5 days' - interval '8 hours'),
                r.submitted_by_role, r.submitted_by_email, r.submitted_at)
        returning id into vid;
        insert into public.accommodation_report_version_counts (version_id, residence_code, male, female)
        select vid, c.residence_code, coalesce(c.male, c.total_unsplit, 0), coalesce(c.female, 0)
          from public.monthly_report_counts c where c.report_id = r.id and coalesce(c.male + c.female, c.total_unsplit, 0) > 0;
        insert into public.accommodation_period_events (spot_id, year, month, action, version_id, reason, actor_role, actor_email, at)
        values (r.spot_id, r.year, r.month, 'submitted', vid, 'Copied from the hand-typed monthly report', r.submitted_by_role, r.submitted_by_email, r.submitted_at);
        if r.locked_at is not null then
            insert into public.accommodation_periods (spot_id, year, month, finalized_at, finalized_by_email, finalized_version_id)
            values (r.spot_id, r.year, r.month, r.locked_at, r.locked_by_email, vid)
            on conflict (spot_id, year, month) do nothing;
            insert into public.accommodation_period_events (spot_id, year, month, action, version_id, reason, actor_role, actor_email, at)
            values (r.spot_id, r.year, r.month, 'finalized', vid, 'Finalized before the stay register', 'admin', r.locked_by_email, r.locked_at);
        end if;
    end loop;
end $$;


-- ---------------------------------------------------------------------------
-- Foreign keys to bookings, put back if the booking-draft repair above dropped
-- them with the old table (its cascade removes every key pointing at it).
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
    for r in select * from (values ('register_entries', 'register_entries_booking_id_fkey'),
                                   ('reviews', 'reviews_booking_id_fkey'),
                                   ('accommodation_stays', 'accommodation_stays_booking_id_fkey')) v(tbl, con)
    loop
        if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = r.tbl and column_name = 'booking_id')
           and not exists (select 1 from pg_constraint c where c.conrelid = ('public.' || r.tbl)::regclass and c.contype = 'f'
                             and c.confrelid = 'public.bookings'::regclass) then
            execute format('alter table public.%I add constraint %I foreign key (booking_id) references public.bookings (id)', r.tbl, r.con);
        end if;
    end loop;
end $$;


-- ===========================================================================
-- Attraction visitor reporting (November 2026, stages 4 and 5; on main 12 November 2026).
-- One authoritative daily count per office-run attraction and date. Monthly
-- reports, versions, DTA2M, VAR 3M and VAR 2 are worked out from it and never
-- typed. Visits to attractions are kept apart from accommodation arrivals.
-- Proposal and decisions: docs/attraction-reporting/. Old attraction reports
-- (monthly_reports kind 'attraction', the Guest Register of an attraction) and
-- the 2025 municipal totals are left exactly as they are, read-only.
--
-- Missing, zero, unknown and not applicable stay different:
--   no row                      -> the date is missing
--   total = 0                   -> a confirmed zero (every breakdown empty)
--   a breakdown column is null  -> that detail is unknown
--   closed dates                -> spot_closed_dates, read only here
-- Sex by residence is never stored: residence totals and sex totals are
-- independent observations.
-- ===========================================================================

-- When an attraction starts reporting, and its code from the office's list.
create table if not exists public.attraction_settings (
    spot_id             text primary key references public.spots (id),
    reporting_from      date not null
                        constraint attraction_settings_first_of_month check (extract(day from reporting_from) = 1),
    attraction_code     text not null default ''
                        constraint attraction_settings_code_length check (char_length(attraction_code) <= 20),
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create table if not exists public.attraction_daily_counts (
    id                  text primary key default public.ztims_new_id(),
    spot_id             text not null references public.spots (id),
    count_date          date not null
                        constraint attraction_daily_counts_date_range check (count_date between date '2000-01-01' and date '2100-12-31'),
    -- The confirmed total. A row exists only when someone confirmed it.
    total               integer not null
                        constraint attraction_daily_counts_total check (total between 0 and 100000),
    -- Usual residence, four classes that never overlap. Null = not recorded.
    res_zamboanguita    integer,
    res_negros_oriental integer,
    res_other_province  integer,
    res_foreign         integer,
    residence_complete  boolean not null default false,
    -- Sex, an independent observation. Null = not recorded.
    male                integer,
    female              integer,
    sex_complete        boolean not null default false,
    -- Optimistic lock and retry key: a save names the revision it read, and a
    -- repeat of the same request (same key) answers with the first result.
    revision            integer not null default 1 constraint attraction_daily_counts_revision check (revision >= 1),
    last_request_key    text not null default '' constraint attraction_daily_counts_key_length check (char_length(last_request_key) <= 64),
    created_by_email    text not null default '',
    updated_by_email    text not null default '',
    updated_by_role     text not null default '',
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    constraint attraction_daily_counts_once unique (spot_id, count_date),
    constraint attraction_daily_counts_residence check (
        coalesce(res_zamboanguita, 0) >= 0 and coalesce(res_negros_oriental, 0) >= 0
        and coalesce(res_other_province, 0) >= 0 and coalesce(res_foreign, 0) >= 0
        and coalesce(res_zamboanguita, 0) + coalesce(res_negros_oriental, 0) + coalesce(res_other_province, 0) + coalesce(res_foreign, 0) <= total
        and (not residence_complete
             or coalesce(res_zamboanguita, 0) + coalesce(res_negros_oriental, 0) + coalesce(res_other_province, 0) + coalesce(res_foreign, 0) = total)),
    constraint attraction_daily_counts_sex check (
        coalesce(male, 0) >= 0 and coalesce(female, 0) >= 0
        and coalesce(male, 0) + coalesce(female, 0) <= total
        and (not sex_complete or coalesce(male, 0) + coalesce(female, 0) = total)),
    constraint attraction_daily_counts_zero check (
        total > 0 or (res_zamboanguita is null and res_negros_oriental is null and res_other_province is null and res_foreign is null
                      and male is null and female is null and not residence_complete and not sex_complete))
);
create index if not exists attraction_daily_counts_month_idx on public.attraction_daily_counts (spot_id, count_date);

-- Every create and change of a daily count: before, after, who, when. Never edited.
create table if not exists public.attraction_count_changes (
    id                  text primary key default public.ztims_new_id(),
    spot_id             text not null references public.spots (id),
    count_date          date not null,
    action              text not null constraint attraction_count_changes_action check (action in ('created', 'updated')),
    before              jsonb,
    after               jsonb,
    actor_role          text not null default '',
    actor_email         text not null default '',
    at                  timestamptz not null default now()
);
create index if not exists attraction_count_changes_idx on public.attraction_count_changes (spot_id, count_date, at);

-- A submitted month: its figures as of then, worked out from the daily counts
-- and checked against them when it is saved. Never changed or removed.
create table if not exists public.attraction_report_versions (
    id                  text primary key default public.ztims_new_id(),
    spot_id             text not null references public.spots (id),
    year                integer not null constraint attraction_report_versions_year check (year between 2000 and 2100),
    month               integer not null constraint attraction_report_versions_month check (month between 1 and 12),
    version             integer not null constraint attraction_report_versions_version check (version >= 1),
    dates_counted       integer not null constraint attraction_report_versions_dates check (dates_counted >= 0),
    zero_days           integer not null default 0 constraint attraction_report_versions_zero check (zero_days >= 0),
    closed_days         integer not null default 0 constraint attraction_report_versions_closed check (closed_days >= 0),
    total               integer not null constraint attraction_report_versions_total check (total >= 0),
    res_zamboanguita    integer not null default 0 constraint attraction_report_versions_r1 check (res_zamboanguita >= 0),
    res_negros_oriental integer not null default 0 constraint attraction_report_versions_r2 check (res_negros_oriental >= 0),
    res_other_province  integer not null default 0 constraint attraction_report_versions_r3 check (res_other_province >= 0),
    res_foreign         integer not null default 0 constraint attraction_report_versions_r4 check (res_foreign >= 0),
    res_unrecorded      integer not null default 0 constraint attraction_report_versions_r5 check (res_unrecorded >= 0),
    male                integer not null default 0 constraint attraction_report_versions_m check (male >= 0),
    female              integer not null default 0 constraint attraction_report_versions_f check (female >= 0),
    sex_unrecorded      integer not null default 0 constraint attraction_report_versions_s check (sex_unrecorded >= 0),
    daily               jsonb not null,
    source_digest       text not null default '',
    reason              text not null default '' constraint attraction_report_versions_reason check (char_length(reason) <= 300),
    submitted_by_role   text not null default '',
    submitted_by_email  text not null default '',
    submitted_at        timestamptz not null default now(),
    constraint attraction_report_versions_once unique (spot_id, year, month, version),
    constraint attraction_report_versions_residence_adds check
        (res_zamboanguita + res_negros_oriental + res_other_province + res_foreign + res_unrecorded = total),
    constraint attraction_report_versions_sex_adds check (male + female + sex_unrecorded = total)
);

-- Where each month stands. 'submitted' and 'finalized' lock the month's daily
-- counts; 'reopened' unlocks them. finalized_version_id stays on a reopened
-- month: the last finalized version remains the official one until a
-- replacement is finalized, so an old and a new version are never both counted.
create table if not exists public.attraction_periods (
    spot_id             text not null references public.spots (id),
    year                integer not null,
    month               integer not null,
    state               text not null constraint attraction_periods_state check (state in ('submitted', 'finalized', 'reopened')),
    current_version_id  text not null references public.attraction_report_versions (id),
    finalized_version_id text references public.attraction_report_versions (id),
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    primary key (spot_id, year, month)
);

create table if not exists public.attraction_period_events (
    id                  text primary key default public.ztims_new_id(),
    spot_id             text not null references public.spots (id),
    year                integer not null,
    month               integer not null,
    action              text not null constraint attraction_period_events_action check (action in ('submitted', 'finalized', 'reopened')),
    version_id          text not null references public.attraction_report_versions (id),
    reason              text not null default '' constraint attraction_period_events_reason check (char_length(reason) <= 300),
    actor_role          text not null default '',
    actor_email         text not null default '',
    at                  timestamptz not null default now(),
    constraint attraction_period_events_reopen_reason check (action <> 'reopened' or char_length(btrim(reason)) >= 10)
);
create index if not exists attraction_period_events_idx on public.attraction_period_events (spot_id, year, month, at);

-- An issued DTA2M or VAR 3M: exactly which finalized versions it was built
-- from. Reopening a month it used marks it needs_regeneration; issuing its
-- replacement marks it superseded. The old one is kept.
create table if not exists public.attraction_outputs (
    id                  text primary key default public.ztims_new_id(),
    kind                text not null constraint attraction_outputs_kind check (kind in ('DTA2M', 'VAR3M')),
    year                integer not null constraint attraction_outputs_year check (year between 2000 and 2100),
    month               integer constraint attraction_outputs_month check (month is null or month between 1 and 12),
    status              text not null default 'current' constraint attraction_outputs_status check (status in ('current', 'needs_regeneration', 'superseded')),
    composition         jsonb not null,
    issued_by_email     text not null default '',
    issued_at           timestamptz not null default now(),
    status_changed_at   timestamptz,
    constraint attraction_outputs_period check ((kind = 'DTA2M') = (month is not null))
);
create index if not exists attraction_outputs_idx on public.attraction_outputs (kind, year, month, status);

-- ---- Rules the database holds ------------------------------------------------
create or replace function public.attraction_assert_place(p_spot text)
returns void language plpgsql set search_path = '' as $$
begin
    if not exists (select 1 from public.spots s where s.id = p_spot and s.type = 'spot' and s.managed_by is null) then
        raise exception 'NOT_ATTRACTION %', p_spot using errcode = 'P0001';
    end if;
end $$;

create or replace function public.attraction_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
    raise exception 'IMMUTABLE %', tg_table_name using errcode = 'P0001';
end $$;

-- A daily count: only for an office-run attraction, on or after its first
-- reporting month, not after today (Manila), never on an authorized closure,
-- never in a submitted or finalized month, never removed, revision moves by one.
create or replace function public.attraction_counts_guard()
returns trigger language plpgsql set search_path = '' as $$
declare st text; first_month date;
begin
    if tg_op = 'DELETE' then
        raise exception 'IMMUTABLE_DELETE %', tg_table_name using errcode = 'P0001';
    end if;
    perform public.attraction_assert_place(new.spot_id);
    if tg_op = 'UPDATE' then
        if new.spot_id <> old.spot_id or new.count_date <> old.count_date then
            raise exception 'KEY_FIXED' using errcode = 'P0001';
        end if;
        if new.revision <> old.revision + 1 then
            raise exception 'REVISION' using errcode = 'P0001';
        end if;
    end if;
    if new.count_date > (now() at time zone 'Asia/Manila')::date then
        raise exception 'FUTURE_DATE %', new.count_date using errcode = 'P0001';
    end if;
    select reporting_from into first_month from public.attraction_settings where spot_id = new.spot_id;
    if first_month is null or new.count_date < first_month then
        raise exception 'BEFORE_REPORTING %', coalesce(to_char(first_month, 'YYYY-MM'), 'none') using errcode = 'P0001';
    end if;
    if exists (select 1 from public.spot_closed_dates c where c.spot_id = new.spot_id and c.closed_date = new.count_date) then
        raise exception 'CLOSED_DATE %', new.count_date using errcode = 'P0001';
    end if;
    select state into st from public.attraction_periods p
     where p.spot_id = new.spot_id and p.year = extract(year from new.count_date)::int and p.month = extract(month from new.count_date)::int;
    if st in ('submitted', 'finalized') then
        raise exception 'PERIOD_LOCKED %', to_char(new.count_date, 'YYYY-MM') using errcode = 'P0001';
    end if;
    return new;
end $$;

-- The month's dates all accounted for: a daily count or an authorized closure.
create or replace function public.attraction_month_missing(p_spot text, p_year integer, p_month integer)
returns integer language sql stable set search_path = '' as $$
    select count(*)::integer
      from generate_series(make_date(p_year, p_month, 1), (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date, interval '1 day') d
     where not exists (select 1 from public.attraction_daily_counts c where c.spot_id = p_spot and c.count_date = d::date)
       and not exists (select 1 from public.spot_closed_dates x where x.spot_id = p_spot and x.closed_date = d::date)
$$;

create or replace function public.attraction_version_guard()
returns trigger language plpgsql set search_path = '' as $$
declare st text; prev integer; first_month date;
begin
    perform public.attraction_assert_place(new.spot_id);
    select state into st from public.attraction_periods p where p.spot_id = new.spot_id and p.year = new.year and p.month = new.month;
    if st in ('submitted', 'finalized') then
        raise exception 'PERIOD_LOCKED %-%', new.year, lpad(new.month::text, 2, '0') using errcode = 'P0001';
    end if;
    select reporting_from into first_month from public.attraction_settings where spot_id = new.spot_id;
    if first_month is null or make_date(new.year, new.month, 1) < first_month then
        raise exception 'BEFORE_REPORTING %-%', new.year, lpad(new.month::text, 2, '0') using errcode = 'P0001';
    end if;
    if (make_date(new.year, new.month, 1) + interval '1 month - 1 day')::date >= (now() at time zone 'Asia/Manila')::date then
        raise exception 'MONTH_NOT_ENDED %-%', new.year, lpad(new.month::text, 2, '0') using errcode = 'P0001';
    end if;
    if public.attraction_month_missing(new.spot_id, new.year, new.month) > 0 then
        raise exception 'MONTH_INCOMPLETE %-%', new.year, lpad(new.month::text, 2, '0') using errcode = 'P0001';
    end if;
    select coalesce(max(version), 0) into prev from public.attraction_report_versions v
     where v.spot_id = new.spot_id and v.year = new.year and v.month = new.month;
    if new.version <> prev + 1 then
        raise exception 'VERSION_GAP' using errcode = 'P0001';
    end if;
    return new;
end $$;

-- At commit: a version's totals equal what the daily counts add up to.
create or replace function public.attraction_version_reconcile()
returns trigger language plpgsql set search_path = '' as $$
declare v record; s record;
begin
    select * into v from public.attraction_report_versions where id = new.id;
    select coalesce(sum(total), 0) as total, count(*) as n,
           coalesce(sum(res_zamboanguita), 0) as r1, coalesce(sum(res_negros_oriental), 0) as r2,
           coalesce(sum(res_other_province), 0) as r3, coalesce(sum(res_foreign), 0) as r4,
           coalesce(sum(male), 0) as m, coalesce(sum(female), 0) as f
      into s from public.attraction_daily_counts c
     where c.spot_id = v.spot_id and c.count_date between make_date(v.year, v.month, 1) and (make_date(v.year, v.month, 1) + interval '1 month - 1 day')::date;
    if s.total <> v.total or s.n <> v.dates_counted or s.r1 <> v.res_zamboanguita or s.r2 <> v.res_negros_oriental
       or s.r3 <> v.res_other_province or s.r4 <> v.res_foreign or s.m <> v.male or s.f <> v.female then
        raise exception 'VERSION_DRIFT %-%', v.year, lpad(v.month::text, 2, '0') using errcode = 'P0001';
    end if;
    return null;
end $$;

-- Month state changes: submitted -> finalized | reopened, finalized -> reopened,
-- reopened -> submitted. Never removed, never moved to another month.
create or replace function public.attraction_period_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
    if tg_op = 'DELETE' then
        raise exception 'IMMUTABLE_DELETE %', tg_table_name using errcode = 'P0001';
    end if;
    if tg_op = 'INSERT' then
        if new.state <> 'submitted' or new.finalized_version_id is not null then
            raise exception 'BAD_TRANSITION' using errcode = 'P0001';
        end if;
        return new;
    end if;
    if new.spot_id <> old.spot_id or new.year <> old.year or new.month <> old.month then
        raise exception 'KEY_FIXED' using errcode = 'P0001';
    end if;
    if not ((old.state = 'submitted' and new.state in ('finalized', 'reopened'))
         or (old.state = 'finalized' and new.state = 'reopened')
         or (old.state = 'reopened' and new.state = 'submitted')) then
        raise exception 'BAD_TRANSITION % %', old.state, new.state using errcode = 'P0001';
    end if;
    if new.state = 'finalized' and new.finalized_version_id is distinct from new.current_version_id then
        raise exception 'BAD_TRANSITION' using errcode = 'P0001';
    end if;
    if new.state in ('submitted', 'reopened') and new.finalized_version_id is distinct from old.finalized_version_id then
        raise exception 'BAD_TRANSITION' using errcode = 'P0001';
    end if;
    return new;
end $$;

-- An issued output: only its status may change, never removed.
create or replace function public.attraction_output_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
    if tg_op = 'DELETE' then
        raise exception 'IMMUTABLE_DELETE %', tg_table_name using errcode = 'P0001';
    end if;
    if new.id <> old.id or new.kind <> old.kind or new.year <> old.year or new.month is distinct from old.month
       or new.composition <> old.composition or new.issued_by_email <> old.issued_by_email or new.issued_at <> old.issued_at then
        raise exception 'IMMUTABLE %', tg_table_name using errcode = 'P0001';
    end if;
    return new;
end $$;

-- The earlier attraction records stay as they were, read only: no new attraction
-- monthly report (kind 'attraction'), no change to its counts, no new Guest
-- Register entry for an attraction. Voiding, finalizing and reopening an old
-- report stay possible. Private places to stay and the 2025 totals are untouched.
create or replace function public.attraction_legacy_guard()
returns trigger language plpgsql set search_path = '' as $$
declare k text; rid text;
begin
    if tg_table_name = 'monthly_reports' then
        if tg_op = 'INSERT' and new.kind = 'attraction' then
            raise exception 'LEGACY_ATTRACTION_FROZEN' using errcode = 'P0001';
        end if;
        if tg_op = 'UPDATE' and old.kind = 'attraction' and (
               new.kind <> old.kind or new.spot_id is distinct from old.spot_id or new.year <> old.year or new.month <> old.month
               or new.rooms is distinct from old.rooms or new.room_nights_occupied is distinct from old.room_nights_occupied
               or new.guest_nights is distinct from old.guest_nights or new.submitted_by_email is distinct from old.submitted_by_email
               or new.submitted_at is distinct from old.submitted_at) then
            raise exception 'LEGACY_ATTRACTION_FROZEN' using errcode = 'P0001';
        end if;
        return coalesce(new, old);
    elsif tg_table_name = 'monthly_report_counts' then
        rid := coalesce(new.report_id, old.report_id);
        select kind into k from public.monthly_reports where id = rid;
        if k = 'attraction' then raise exception 'LEGACY_ATTRACTION_FROZEN' using errcode = 'P0001'; end if;
        return coalesce(new, old);
    elsif tg_table_name = 'register_entries' then
        if exists (select 1 from public.spots s where s.id = coalesce(new.spot_id, old.spot_id) and s.type = 'spot') then
            raise exception 'LEGACY_REGISTER_FROZEN' using errcode = 'P0001';
        end if;
        return coalesce(new, old);
    else
        select e.spot_id into rid from public.register_entries e where e.id = coalesce(new.entry_id, old.entry_id);
        if exists (select 1 from public.spots s where s.id = rid and s.type = 'spot') then
            raise exception 'LEGACY_REGISTER_FROZEN' using errcode = 'P0001';
        end if;
        return coalesce(new, old);
    end if;
end $$;

do $$
declare t text;
begin
    foreach t in array array['attraction_settings', 'attraction_daily_counts', 'attraction_count_changes', 'attraction_report_versions',
                             'attraction_periods', 'attraction_period_events', 'attraction_outputs'] loop
        execute format('alter table public.%I enable row level security', t);
    end loop;
    foreach t in array array['attraction_settings', 'attraction_daily_counts', 'attraction_periods'] loop
        execute format('drop trigger if exists %I on public.%I', t || '_touch_updated_at', t);
        execute format('create trigger %I before update on public.%I for each row execute function public.ztims_touch_updated_at()', t || '_touch_updated_at', t);
    end loop;
    foreach t in array array['attraction_count_changes', 'attraction_report_versions', 'attraction_period_events'] loop
        execute format('drop trigger if exists %I on public.%I', t || '_immutable', t);
        execute format('create trigger %I before update or delete on public.%I for each row execute function public.attraction_immutable()', t || '_immutable', t);
    end loop;
    drop trigger if exists attraction_daily_counts_guard on public.attraction_daily_counts;
    create trigger attraction_daily_counts_guard before insert or update or delete on public.attraction_daily_counts
        for each row execute function public.attraction_counts_guard();
    drop trigger if exists attraction_report_versions_guard on public.attraction_report_versions;
    create trigger attraction_report_versions_guard before insert on public.attraction_report_versions
        for each row execute function public.attraction_version_guard();
    drop trigger if exists attraction_report_versions_reconcile on public.attraction_report_versions;
    create constraint trigger attraction_report_versions_reconcile after insert on public.attraction_report_versions
        deferrable initially deferred for each row execute function public.attraction_version_reconcile();
    drop trigger if exists attraction_periods_guard on public.attraction_periods;
    create trigger attraction_periods_guard before insert or update or delete on public.attraction_periods
        for each row execute function public.attraction_period_guard();
    drop trigger if exists attraction_outputs_guard on public.attraction_outputs;
    create trigger attraction_outputs_guard before update or delete on public.attraction_outputs
        for each row execute function public.attraction_output_guard();
    drop trigger if exists monthly_reports_attraction_legacy on public.monthly_reports;
    create trigger monthly_reports_attraction_legacy before insert or update on public.monthly_reports
        for each row execute function public.attraction_legacy_guard();
    drop trigger if exists monthly_report_counts_attraction_legacy on public.monthly_report_counts;
    create trigger monthly_report_counts_attraction_legacy before insert or update or delete on public.monthly_report_counts
        for each row execute function public.attraction_legacy_guard();
    drop trigger if exists register_entries_attraction_legacy on public.register_entries;
    create trigger register_entries_attraction_legacy before insert or update or delete on public.register_entries
        for each row execute function public.attraction_legacy_guard();
    drop trigger if exists register_entry_guests_attraction_legacy on public.register_entry_guests;
    create trigger register_entry_guests_attraction_legacy before insert or update or delete on public.register_entry_guests
        for each row execute function public.attraction_legacy_guard();
end $$;

-- ---------------------------------------------------------------------------
-- Room booking: pay at the property or pay online (November 2026, the user's
-- choice from docs/booking-payment/mockup.html). The guest chooses when asking
-- for the rooms; an online payment is made only after the resort confirms,
-- for what is still owed, through the same Xendit test-mode demonstration as
-- tickets (payments.js). The money goes nowhere real: every online record is
-- is_demo. Re-runnable.
-- ---------------------------------------------------------------------------
alter table public.enterprise_booking_settings add column if not exists allow_pay_at_property boolean not null default true;
alter table public.enterprise_booking_settings add column if not exists allow_pay_online boolean not null default false;
do $$ begin
    if not exists (select 1 from pg_constraint where conname = 'booking_settings_some_payment') then
        alter table public.enterprise_booking_settings add constraint booking_settings_some_payment
            check (allow_pay_at_property or allow_pay_online);
    end if;
end $$;

alter table public.bookings add column if not exists payment_choice text not null default 'property';
do $$ begin
    if not exists (select 1 from pg_constraint where conname = 'bookings_payment_choice') then
        alter table public.bookings add constraint bookings_payment_choice check (payment_choice in ('property', 'online'));
    end if;
end $$;

-- A payment the manager records (manual) or one an online checkout made
-- (online, with the gateway's reference), and its refund.
alter table public.booking_payments add column if not exists channel text not null default 'manual';
alter table public.booking_payments add column if not exists gateway_ref text not null default '';
alter table public.booking_payments add column if not exists is_demo boolean not null default false;
alter table public.booking_payments add column if not exists refunded_at timestamptz;
alter table public.booking_payments add column if not exists refund_amount numeric(12, 2);
alter table public.booking_payments add column if not exists refund_reason text not null default '';
alter table public.booking_payments drop constraint if exists booking_payments_method;
alter table public.booking_payments add constraint booking_payments_method
    check (method in ('cash', 'gcash', 'maya', 'bank', 'card', 'qrph', 'otc', 'other'));
do $$ begin
    if not exists (select 1 from pg_constraint where conname = 'booking_payments_channel') then
        alter table public.booking_payments add constraint booking_payments_channel check (channel in ('manual', 'online'));
    end if;
    if not exists (select 1 from pg_constraint where conname = 'booking_payments_refund') then
        alter table public.booking_payments add constraint booking_payments_refund
            check (refund_amount is null or (refund_amount >= 0 and refund_amount <= amount));
    end if;
end $$;
create unique index if not exists booking_payments_gateway_ref_idx on public.booking_payments (gateway_ref) where gateway_ref <> '';

-- One invoice at the gateway per row; external_id ztims-b-<id>.
create table if not exists public.booking_checkouts (
    id                  text primary key default public.ztims_new_id(),
    booking_id          text not null references public.bookings (id),
    amount              numeric(12, 2) not null constraint booking_checkouts_amount check (amount > 0 and amount <= 10000000),
    status              text not null default 'pending'
                        constraint booking_checkouts_status check (status in ('pending', 'paid', 'expired', 'duplicate')),
    session_id          text not null default '',
    checkout_url        text not null default '',
    method              text not null default '',
    payment_ref         text not null default '',
    paid_at             timestamptz,
    expires_at          timestamptz not null,
    is_demo             boolean not null default true,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);
create index if not exists booking_checkouts_booking_idx on public.booking_checkouts (booking_id, created_at);
drop trigger if exists booking_checkouts_touch_updated_at on public.booking_checkouts;
create trigger booking_checkouts_touch_updated_at before update on public.booking_checkouts
    for each row execute function public.ztims_touch_updated_at();
alter table public.booking_checkouts enable row level security;
