-- The seven booking tables exactly as live holds them (read 11 Nov 2026).
drop table if exists booking_payments, booking_changes, booking_rooms, bookings, room_blocks, room_types, enterprise_booking_settings cascade;
create table enterprise_booking_settings (spot_id text primary key references spots(id), accepts_bookings boolean not null default false,
  advance_days integer not null default 365 constraint ebs_advance_days check (advance_days between 1 and 730),
  check_in_time text not null default '14:00', check_out_time text not null default '12:00',
  free_cancel_days integer not null default 3 constraint ebs_free_cancel_days check (free_cancel_days between 0 and 60),
  max_nights integer not null default 30 constraint ebs_max_nights check (max_nights between 1 and 365),
  min_nights integer not null default 1 constraint ebs_min_nights check (min_nights between 1 and 60),
  paused_by_office boolean not null default false,
  payment_instructions text not null default '' constraint ebs_payment_instructions check (char_length(payment_instructions) <= 1000),
  response_hours integer not null default 24 constraint ebs_response_hours check (response_hours between 1 and 168),
  updated_at timestamptz not null default now(), constraint ebs_nights_order check (max_nights >= min_nights));
create table room_types (id text primary key default ztims_new_id(), spot_id text not null references spots(id),
  name text not null constraint room_types_name check (char_length(name) between 1 and 80),
  description text not null default '' constraint room_types_description check (char_length(description) <= 600),
  beds text not null default '' constraint room_types_beds check (char_length(beds) <= 80),
  max_guests integer not null default 2 constraint room_types_max_guests check (max_guests between 1 and 50),
  base_rate numeric not null constraint room_types_base_rate check (base_rate >= 0),
  units integer not null default 1 constraint room_types_units check (units between 1 and 500),
  photo_url text not null default '', active boolean not null default true, position integer not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create index room_types_spot_idx on room_types (spot_id, position);
create table room_blocks (id text primary key default ztims_new_id(), room_type_id text not null references room_types(id),
  starts_on date not null, ends_on date not null, units integer not null default 1 constraint room_blocks_units check (units between 1 and 500),
  reason text not null default '' constraint room_blocks_reason check (char_length(reason) <= 200), created_by_email text not null default '',
  created_at timestamptz not null default now(), constraint room_blocks_dates check (ends_on >= starts_on));
create index room_blocks_room_idx on room_blocks (room_type_id, starts_on, ends_on);
create table bookings (id text primary key default ztims_new_id(), code text not null unique, spot_id text not null references spots(id),
  guest_name text not null constraint bookings_guest_name check (char_length(guest_name) between 1 and 120),
  email text not null constraint bookings_email check (char_length(email) <= 254),
  phone text not null default '' constraint bookings_phone check (char_length(phone) <= 40),
  country_code text references residences(code),
  adults integer not null default 1 constraint bookings_adults check (adults between 1 and 100),
  children integer not null default 0 constraint bookings_children check (children between 0 and 100),
  check_in date not null, check_out date not null, nights integer generated always as (check_out - check_in) stored,
  status text not null default 'requested' constraint bookings_status check (status in ('requested','confirmed','checked_in','completed','declined','expired','cancelled','no_show')),
  total_amount numeric not null default 0 constraint bookings_total check (total_amount >= 0),
  note text not null default '' constraint bookings_note check (char_length(note) <= 500),
  decline_reason text not null default '' constraint bookings_decline_reason check (char_length(decline_reason) <= 300),
  expires_at timestamptz not null, reminder_sent_at timestamptz, decided_by_email text not null default '', decided_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), visitor_id text references visitors(id),
  constraint bookings_dates check (check_out > check_in));
create index bookings_email_idx on bookings (lower(email)); create index bookings_spot_dates_idx on bookings (spot_id, check_in, check_out);
create index bookings_status_expiry_idx on bookings (status, expires_at); create index bookings_visitor_idx on bookings (visitor_id) where visitor_id is not null;
create table booking_rooms (booking_id text not null references bookings(id) on delete cascade, room_type_id text not null references room_types(id),
  units integer not null constraint booking_rooms_units check (units between 1 and 500), rate_per_night numeric not null constraint booking_rooms_rate check (rate_per_night >= 0),
  primary key (booking_id, room_type_id));
create index booking_rooms_room_idx on booking_rooms (room_type_id);
create table booking_changes (id text primary key default ztims_new_id(), booking_id text not null references bookings(id),
  action text not null constraint booking_changes_action check (action in ('request','confirm','decline','expire','cancel','move','adjust_price','payment','check_in','complete','no_show')),
  reason text not null default '' constraint booking_changes_reason check (char_length(reason) <= 300), by_email text not null default '',
  before jsonb, after jsonb, at timestamptz not null default now());
create table booking_payments (id text primary key default ztims_new_id(), booking_id text not null references bookings(id),
  amount numeric not null constraint booking_payments_amount check (amount > 0), method text not null default '' constraint booking_payments_method check (char_length(method) <= 60),
  received_on date not null default current_date, reference text not null default '' constraint booking_payments_reference check (char_length(reference) <= 120),
  recorded_by_email text not null default '', created_at timestamptz not null default now());
alter table register_entries add constraint register_entries_booking_id_fkey foreign key (booking_id) references bookings(id);
alter table reviews add constraint reviews_booking_id_fkey foreign key (booking_id) references bookings(id);
