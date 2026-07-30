-- 卡组编辑器与本地目录展示所需的非经济卡牌资料；历史目录保留空值，后续受控同步补全。
ALTER TABLE card_printings ADD COLUMN mana_cost TEXT;
ALTER TABLE card_printings ADD COLUMN colors_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE card_printings ADD COLUMN power TEXT;
ALTER TABLE card_printings ADD COLUMN toughness TEXT;
