-- Demo flags: run after migration.sql
-- Usage: psql $DATABASE_URL -f seed.sql

INSERT INTO openfeature.feature_flags (flag_key, flag_type, default_variant, enabled)
VALUES
	('dark-mode', 'boolean', 'off', true),
	('greeting', 'string', 'default', true),
	('max-items', 'number', 'standard', true),
	('banner', 'object', 'promo', true),
	('maintenance', 'boolean', 'off', false)
ON CONFLICT (flag_key) DO NOTHING;

INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value)
VALUES
	('dark-mode', 'on', 'boolean', 'true'),
	('dark-mode', 'off', 'boolean', 'false'),
	('greeting', 'default', 'string', '"Hello, world!"'),
	('greeting', 'friendly', 'string', '"Hey there, friend!"'),
	('max-items', 'standard', 'number', '25'),
	('max-items', 'premium', 'number', '100'),
	('banner', 'promo', 'object', '{"text": "Welcome! Check out our new features.", "color": "#4f46e5"}'),
	('banner', 'holiday', 'object', '{"text": "Happy holidays from the team!", "color": "#dc2626"}'),
	('maintenance', 'on', 'boolean', 'true'),
	('maintenance', 'off', 'boolean', 'false')
ON CONFLICT (flag_key, variant) DO NOTHING;

-- 50/50 rollout: some users get the friendly greeting
INSERT INTO openfeature.flag_rollouts (flag_key, variant, percentage)
VALUES ('greeting', 'friendly', 50)
ON CONFLICT (flag_key, variant) DO NOTHING;
