-- I25B：个人 NPC 日赛。每个 (模板、业务日、玩家) 都是隔离的赛事实例；种子及重放材料只追加。
CREATE TABLE tournament_templates (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('single','swiss','prereg')),
  total_seats INTEGER NOT NULL CHECK (total_seats BETWEEN 2 AND 4096),
  entry_fee_amount INTEGER NOT NULL CHECK (entry_fee_amount >= 0),
  difficulty INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 10),
  reward_amount INTEGER NOT NULL CHECK (reward_amount >= 0),
  entry_condition TEXT NOT NULL CHECK (entry_condition = 'valid_commander_deck'),
  daily_registration_limit INTEGER NOT NULL CHECK (daily_registration_limit > 0),
  start_mode TEXT NOT NULL CHECK (start_mode IN ('on_registration','at_cutoff')),
  opens_at TEXT NOT NULL,
  cutoff_at TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO tournament_templates (id, version, kind, total_seats, entry_fee_amount, difficulty, reward_amount, entry_condition, daily_registration_limit, start_mode, opens_at, cutoff_at, created_at) VALUES
  ('daily-npc-single/v1', 'tournament/v1', 'single', 2, 0, 2, 100, 'valid_commander_deck', 1, 'on_registration', '00:00', NULL, '2026-07-29T00:00:00.000Z'),
  ('daily-npc-swiss/v1', 'tournament/v1', 'swiss', 4, 0, 4, 250, 'valid_commander_deck', 1, 'on_registration', '00:00', NULL, '2026-07-29T00:00:00.000Z'),
  ('daily-npc-prereg/v1', 'tournament/v1', 'prereg', 8, 0, 6, 500, 'valid_commander_deck', 1, 'at_cutoff', '00:00', '20:00', '2026-07-29T00:00:00.000Z');

CREATE TABLE tournaments (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES tournament_templates(id),
  natural_date TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  timezone TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','settling','settled','cancelled')),
  rule_version TEXT NOT NULL,
  seed TEXT NOT NULL,
  seed_hash TEXT NOT NULL,
  opens_at TEXT NOT NULL,
  cutoff_at TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT,
  UNIQUE(template_id, natural_date, owner_user_id)
);
CREATE INDEX tournaments_owner_date_index ON tournaments(owner_user_id, natural_date DESC, created_at DESC);
CREATE TABLE tournament_registrations (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  deck_id TEXT NOT NULL REFERENCES decks(id),
  power_snapshot_id TEXT NOT NULL UNIQUE REFERENCES deck_power_snapshots(id),
  status TEXT NOT NULL CHECK (status IN ('registered','settled','eliminated')),
  entry_fee_amount INTEGER NOT NULL CHECK (entry_fee_amount >= 0),
  entry_fee_hold_id TEXT,
  registered_at TEXT NOT NULL,
  settled_at TEXT,
  UNIQUE(tournament_id, user_id),
  UNIQUE(tournament_id, deck_id)
);
CREATE TABLE tournament_registration_holds (
  registration_id TEXT NOT NULL REFERENCES tournament_registrations(id) ON DELETE CASCADE,
  sku_id TEXT NOT NULL REFERENCES card_skus(id),
  inventory_hold_id TEXT NOT NULL UNIQUE REFERENCES inventory_holds(id),
  PRIMARY KEY (registration_id, sku_id)
);
-- 报名卡组是不可变输入：卡组之后被编辑、禁牌表更新或库存变动均不改写历史赛果。
CREATE TABLE tournament_deck_card_snapshots (
  id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL UNIQUE,
  deck_id TEXT NOT NULL REFERENCES decks(id),
  deck_rule_version TEXT NOT NULL,
  banlist_version TEXT NOT NULL,
  cards_json TEXT NOT NULL,
  cards_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE tournament_npcs (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  seat INTEGER NOT NULL CHECK (seat > 0),
  name TEXT NOT NULL,
  power_score INTEGER NOT NULL CHECK (power_score BETWEEN 0 AND 100),
  UNIQUE(tournament_id, seat)
);
CREATE TABLE tournament_results (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id),
  registration_id TEXT NOT NULL UNIQUE REFERENCES tournament_registrations(id),
  rank INTEGER NOT NULL CHECK (rank > 0),
  wins INTEGER NOT NULL CHECK (wins >= 0),
  draws INTEGER NOT NULL CHECK (draws >= 0),
  losses INTEGER NOT NULL CHECK (losses >= 0),
  points INTEGER NOT NULL CHECK (points >= 0),
  outcome_json TEXT NOT NULL,
  replay_json TEXT NOT NULL,
  reward_amount INTEGER NOT NULL CHECK (reward_amount >= 0),
  settled_at TEXT NOT NULL
);
CREATE TABLE tournament_rewards (
  id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL UNIQUE REFERENCES tournament_registrations(id),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE tournament_reward_pool_entries (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES tournament_templates(id),
  reward_kind TEXT NOT NULL CHECK (reward_kind IN ('GAME_CREDIT','pack','sku')),
  amount INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),
  pack_id TEXT REFERENCES booster_packs(id),
  sku_id TEXT REFERENCES card_skus(id),
  weight INTEGER NOT NULL DEFAULT 1 CHECK (weight > 0),
  min_rank INTEGER NOT NULL DEFAULT 1 CHECK (min_rank > 0),
  max_rank INTEGER NOT NULL DEFAULT 1 CHECK (max_rank >= min_rank),
  rule_version TEXT NOT NULL,
  CHECK ((reward_kind = 'GAME_CREDIT' AND amount > 0 AND pack_id IS NULL AND sku_id IS NULL) OR (reward_kind = 'pack' AND amount = 0 AND pack_id IS NOT NULL AND sku_id IS NULL) OR (reward_kind = 'sku' AND amount = 0 AND pack_id IS NULL AND sku_id IS NOT NULL))
);
CREATE TABLE tournament_reward_draws (
  id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL REFERENCES tournament_registrations(id),
  pool_entry_id TEXT NOT NULL REFERENCES tournament_reward_pool_entries(id),
  seed TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  candidates_json TEXT NOT NULL,
  selected_result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(registration_id)
);
CREATE TABLE tournament_pack_grants (
  id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL REFERENCES tournament_registrations(id),
  pack_id TEXT NOT NULL REFERENCES booster_packs(id),
  status TEXT NOT NULL CHECK (status IN ('available','claimed')),
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  UNIQUE(registration_id)
);
INSERT INTO tournament_reward_pool_entries (id, template_id, reward_kind, amount, pack_id, sku_id, weight, min_rank, max_rank, rule_version) VALUES
  ('daily-npc-single-credit/v1', 'daily-npc-single/v1', 'GAME_CREDIT', 100, NULL, NULL, 1, 1, 1, 'tournament/v1'),
  ('daily-npc-swiss-credit/v1', 'daily-npc-swiss/v1', 'GAME_CREDIT', 250, NULL, NULL, 1, 1, 1, 'tournament/v1'),
  ('daily-npc-prereg-credit/v1', 'daily-npc-prereg/v1', 'GAME_CREDIT', 500, NULL, NULL, 1, 1, 1, 'tournament/v1');

-- 玩家创建的赛事与现实桌瑞士轮：实体卡组名只是玩家填写的文本，绝不进入 deck/inventory 表。
CREATE TABLE player_tournaments (
  id TEXT PRIMARY KEY,
  creator_user_id TEXT NOT NULL REFERENCES users(id),
  mode TEXT NOT NULL CHECK (mode IN ('game','tabletop')),
  format TEXT NOT NULL CHECK (format = 'commander'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  status TEXT NOT NULL CHECK (status IN ('open','in_progress','settled','disputed','cancelled')),
  rule_version TEXT NOT NULL,
  random_seed TEXT NOT NULL,
  seed_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  settled_at TEXT
);
CREATE TABLE player_tournament_registrations (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES player_tournaments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  deck_name TEXT NOT NULL CHECK (length(deck_name) BETWEEN 1 AND 100),
  deck_id TEXT REFERENCES decks(id),
  power_snapshot_id TEXT UNIQUE REFERENCES deck_power_snapshots(id),
  status TEXT NOT NULL CHECK (status IN ('registered','withdrawn','eliminated')),
  points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
  created_at TEXT NOT NULL,
  UNIQUE(tournament_id, user_id)
);
CREATE TABLE player_tournament_registration_holds (
  registration_id TEXT NOT NULL REFERENCES player_tournament_registrations(id) ON DELETE CASCADE,
  sku_id TEXT NOT NULL REFERENCES card_skus(id),
  inventory_hold_id TEXT NOT NULL UNIQUE REFERENCES inventory_holds(id),
  PRIMARY KEY (registration_id, sku_id)
);
CREATE TABLE player_tournament_rounds (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES player_tournaments(id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL CHECK (round_number > 0),
  table_number INTEGER NOT NULL CHECK (table_number > 0),
  status TEXT NOT NULL CHECK (status IN ('pending','submitted','confirmed','disputed')),
  result_type TEXT CHECK (result_type IN ('winner','draw','forfeit')),
  result_json TEXT,
  submitted_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  UNIQUE(tournament_id, round_number, table_number)
);
-- 游戏内与现实桌均将最终名次/规则快照持久化；非 NPC 重放不进入玩家 DTO。
CREATE TABLE player_tournament_results (
  id TEXT PRIMARY KEY,
  player_tournament_id TEXT NOT NULL REFERENCES player_tournaments(id),
  registration_id TEXT NOT NULL UNIQUE REFERENCES player_tournament_registrations(id),
  rank INTEGER NOT NULL CHECK (rank > 0),
  points INTEGER NOT NULL CHECK (points >= 0),
  opponent_points INTEGER NOT NULL CHECK (opponent_points >= 0),
  reward_amount INTEGER NOT NULL DEFAULT 0 CHECK (reward_amount >= 0),
  replay_json TEXT NOT NULL,
  settled_at TEXT NOT NULL
);
CREATE TABLE player_tournament_round_players (
  round_id TEXT NOT NULL REFERENCES player_tournament_rounds(id) ON DELETE CASCADE,
  registration_id TEXT NOT NULL REFERENCES player_tournament_registrations(id),
  is_winner INTEGER NOT NULL DEFAULT 0 CHECK (is_winner IN (0,1)),
  forfeited INTEGER NOT NULL DEFAULT 0 CHECK (forfeited IN (0,1)),
  PRIMARY KEY (round_id, registration_id)
);
CREATE TABLE player_tournament_round_confirmations (
  round_id TEXT NOT NULL REFERENCES player_tournament_rounds(id) ON DELETE CASCADE,
  registration_id TEXT NOT NULL REFERENCES player_tournament_registrations(id),
  confirmed_at TEXT NOT NULL,
  PRIMARY KEY (round_id, registration_id)
);
CREATE TABLE tournament_disputes (
  id TEXT PRIMARY KEY,
  player_tournament_id TEXT NOT NULL REFERENCES player_tournaments(id),
  round_id TEXT NOT NULL REFERENCES player_tournament_rounds(id),
  opened_by_user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('open','resolved')),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  resolution_reason TEXT,
  resolved_by_user_id TEXT REFERENCES users(id),
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(round_id)
);
