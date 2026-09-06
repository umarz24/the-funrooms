-- ============================================================================
-- THE FUNROOMS — 01: the leaderboard table
-- Run this FIRST in the Supabase SQL editor, then 02_accounts.sql.
-- Safe to re-run.
--
-- The columns here are exactly what the client writes in submitScore() and
-- reads back in loadLeaderboard() in public/index.html.
-- ============================================================================

create table if not exists public.scores (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  name        text  not null default 'Player',
  class       text  not null,
  floor       int   not null,
  score       int   not null default 0,
  secs        int   not null default 0,
  outcome     text  not null default 'dead'
);

-- Keep obvious junk out. The client already clamps these, but the table is a
-- public insert target, so it enforces its own bounds.
alter table public.scores drop constraint if exists scores_sane;
alter table public.scores add constraint scores_sane check (
  char_length(name) between 1 and 16
  and char_length(class) <= 20
  and floor between 1 and 100
  and score >= 0
  and secs  >= 0
  and outcome in ('escape','dead','quit')
);

-- The leaderboard query orders by floor then score.
create index if not exists scores_board_idx on public.scores (floor desc, score desc);

alter table public.scores enable row level security;

drop policy if exists "anyone can read scores"   on public.scores;
drop policy if exists "anyone can insert a score" on public.scores;

create policy "anyone can read scores"
  on public.scores for select
  to anon, authenticated
  using (true);

-- Wide-open inserts, which is fine for an offline-first arcade leaderboard.
-- 02_accounts.sql REPLACES this policy with an auth-bound pair once you have
-- accounts, so a signed-in player can only post rows as themselves.
create policy "anyone can insert a score"
  on public.scores for insert
  to anon, authenticated
  with check (true);

-- No update or delete policies: rows are append-only to everyone but you.
