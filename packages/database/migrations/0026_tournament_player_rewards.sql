-- I25B 完整性修复：玩家创建赛事使用独立的报名快照外键，并以受控奖励配置发放可重放奖励。
CREATE TABLE player_tournament_deck_card_snapshots (
  id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL UNIQUE REFERENCES player_tournament_registrations(id) ON DELETE CASCADE,
  deck_id TEXT NOT NULL REFERENCES decks(id),
  deck_rule_version TEXT NOT NULL,
  banlist_version TEXT NOT NULL,
  cards_json TEXT NOT NULL,
  cards_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE player_tournament_reward_profiles (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('game','tabletop')),
  tie_policy TEXT NOT NULL CHECK (tie_policy = 'playoff_at_reward_boundary'),
  created_at TEXT NOT NULL
);
INSERT INTO player_tournament_reward_profiles (id, version, mode, tie_policy, created_at) VALUES
  ('player-game-standard/v1', 'tournament/v1', 'game', 'playoff_at_reward_boundary', '2026-07-29T00:00:00.000Z'),
  ('player-tabletop-standard/v1', 'tournament/v1', 'tabletop', 'playoff_at_reward_boundary', '2026-07-29T00:00:00.000Z');

ALTER TABLE player_tournaments ADD COLUMN reward_profile_id TEXT REFERENCES player_tournament_reward_profiles(id);

CREATE TABLE player_tournament_reward_pool_entries (
  id TEXT PRIMARY KEY,
  reward_profile_id TEXT NOT NULL REFERENCES player_tournament_reward_profiles(id),
  reward_kind TEXT NOT NULL CHECK (reward_kind IN ('GAME_CREDIT','pack','sku')),
  amount INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),
  pack_id TEXT REFERENCES booster_packs(id),
  sku_id TEXT REFERENCES card_skus(id),
  weight INTEGER NOT NULL DEFAULT 1 CHECK (weight > 0),
  min_rank INTEGER NOT NULL CHECK (min_rank > 0),
  max_rank INTEGER NOT NULL CHECK (max_rank >= min_rank),
  rule_version TEXT NOT NULL,
  CHECK ((reward_kind = 'GAME_CREDIT' AND amount > 0 AND pack_id IS NULL AND sku_id IS NULL) OR (reward_kind = 'pack' AND amount = 0 AND pack_id IS NOT NULL AND sku_id IS NULL) OR (reward_kind = 'sku' AND amount = 0 AND pack_id IS NULL AND sku_id IS NOT NULL))
);
INSERT INTO player_tournament_reward_pool_entries (id, reward_profile_id, reward_kind, amount, pack_id, sku_id, weight, min_rank, max_rank, rule_version) VALUES
  ('player-game-standard-credit/v1', 'player-game-standard/v1', 'GAME_CREDIT', 100, NULL, NULL, 1, 1, 1, 'tournament/v1'),
  ('player-tabletop-standard-credit/v1', 'player-tabletop-standard/v1', 'GAME_CREDIT', 100, NULL, NULL, 1, 1, 1, 'tournament/v1');

CREATE TABLE player_tournament_reward_draws (
  id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL UNIQUE REFERENCES player_tournament_registrations(id),
  pool_entry_id TEXT NOT NULL REFERENCES player_tournament_reward_pool_entries(id),
  seed TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  candidates_json TEXT NOT NULL,
  selected_result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE player_tournament_rewards (
  id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL UNIQUE REFERENCES player_tournament_registrations(id),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE player_tournament_pack_grants (
  id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL UNIQUE REFERENCES player_tournament_registrations(id),
  pack_id TEXT NOT NULL REFERENCES booster_packs(id),
  status TEXT NOT NULL CHECK (status IN ('available','claimed')),
  created_at TEXT NOT NULL,
  claimed_at TEXT
);

ALTER TABLE player_tournament_rounds ADD COLUMN stage TEXT NOT NULL DEFAULT 'normal' CHECK (stage IN ('normal','playoff'));
