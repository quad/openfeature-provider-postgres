CREATE SCHEMA openfeature;

-- Flag definitions
CREATE TABLE openfeature.feature_flags (
    flag_key        TEXT PRIMARY KEY,
    flag_type       TEXT NOT NULL CHECK (flag_type IN ('boolean', 'string', 'number', 'object')),
    enabled         BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (flag_key, flag_type)
);

-- Typed variants (type safety via jsonb_typeof CHECK)
-- is_default: NULL = not the default, TRUE = the default variant for this flag.
-- UNIQUE (flag_key, is_default) enforces at-most-one default per flag: NULLs are
-- considered distinct in PostgreSQL unique indexes, so many NULL rows are allowed,
-- but only one TRUE per flag_key.
CREATE TABLE openfeature.flag_variants (
    flag_key   TEXT NOT NULL,
    variant    TEXT NOT NULL,
    flag_type  TEXT NOT NULL,
    value      JSONB NOT NULL,
    is_default BOOLEAN CHECK (is_default IS NULL OR is_default),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (jsonb_typeof(value) = flag_type),
    PRIMARY KEY (flag_key, variant),
    UNIQUE (flag_key, is_default),
    FOREIGN KEY (flag_key, flag_type) REFERENCES openfeature.feature_flags(flag_key, flag_type)
);

-- Percentage rollouts per variant
CREATE TABLE openfeature.flag_rollouts (
    flag_key   TEXT NOT NULL,
    variant    TEXT NOT NULL,
    percentage INTEGER NOT NULL CHECK (percentage BETWEEN 0 AND 100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (flag_key, variant),
    FOREIGN KEY (flag_key, variant) REFERENCES openfeature.flag_variants(flag_key, variant)
);

-- Notify on any flag change
CREATE FUNCTION openfeature.notify_flag_change() RETURNS TRIGGER AS $$
BEGIN
    NOTIFY flag_change;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER feature_flags_notify
    AFTER INSERT OR DELETE ON openfeature.feature_flags
    FOR EACH ROW EXECUTE FUNCTION openfeature.notify_flag_change();

CREATE TRIGGER feature_flags_notify_update
    AFTER UPDATE ON openfeature.feature_flags
    FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
    EXECUTE FUNCTION openfeature.notify_flag_change();

CREATE TRIGGER flag_variants_notify
    AFTER INSERT OR DELETE ON openfeature.flag_variants
    FOR EACH ROW EXECUTE FUNCTION openfeature.notify_flag_change();

CREATE TRIGGER flag_variants_notify_update
    AFTER UPDATE ON openfeature.flag_variants
    FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
    EXECUTE FUNCTION openfeature.notify_flag_change();

CREATE TRIGGER flag_rollouts_notify
    AFTER INSERT OR DELETE ON openfeature.flag_rollouts
    FOR EACH ROW EXECUTE FUNCTION openfeature.notify_flag_change();

CREATE TRIGGER flag_rollouts_notify_update
    AFTER UPDATE ON openfeature.flag_rollouts
    FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
    EXECUTE FUNCTION openfeature.notify_flag_change();
