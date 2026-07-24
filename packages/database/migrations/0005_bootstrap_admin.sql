-- 仅为首次本地部署提供可登录的管理入口；密码是 Argon2id 哈希，不存储明文。
-- 已存在同邮箱用户时保留其角色、密码与会话，避免迁移覆盖真实管理员。
INSERT INTO users (id, email, display_name, password_hash, role, created_at, updated_at)
VALUES (
  '00000000-0000-4000-8000-000000000005',
  'admin@local.test',
  'admin',
  '$argon2id$v=19$m=19456,p=1,t=2$/v2h7ZaiCGqgcR21kC02/w$Acu15cPUsB6lDakZvVAZZCyzJtrAxkk8oHG8yy1b6z8',
  'admin',
  '2026-07-24T00:00:00.000Z',
  '2026-07-24T00:00:00.000Z'
)
ON CONFLICT(email) DO NOTHING;
