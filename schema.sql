CREATE SCHEMA openfeature;

CREATE TABLE openfeature.feature_flags (
    flag_key        TEXT PRIMARY KEY,
    flag_type       TEXT NOT NULL CHECK (flag_type IN ('boolean', 'string', 'number', 'object')),
    enabled         BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- flag_type is functionally dependent on flag_key, but needs to be part of
    -- a unique constraint so flag_variants can enforce type consistency via FK.
    UNIQUE (flag_key, flag_type)
);

CREATE TABLE openfeature.flag_variants (
    flag_key   TEXT NOT NULL,
    variant    TEXT NOT NULL,
    flag_type  TEXT NOT NULL,
    value      JSONB NOT NULL,
    -- NULL means this is the default (fallback) variant; an integer means it
    -- participates in percentage-based rollout. A single column encodes the
    -- variant's role so that invalid combinations are unrepresentable.
    percentage INTEGER CHECK (percentage IS NULL OR percentage BETWEEN 0 AND 100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (jsonb_typeof(value) = flag_type),
    PRIMARY KEY (flag_key, variant),
    FOREIGN KEY (flag_key, flag_type) REFERENCES openfeature.feature_flags(flag_key, flag_type)
);

CREATE UNIQUE INDEX one_default_per_flag
    ON openfeature.flag_variants (flag_key)
    WHERE percentage IS NULL;

-- Automatic updated_at

CREATE FUNCTION openfeature.set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER feature_flags_set_updated_at
    BEFORE UPDATE ON openfeature.feature_flags
    FOR EACH ROW EXECUTE FUNCTION openfeature.set_updated_at();

CREATE TRIGGER flag_variants_set_updated_at
    BEFORE UPDATE ON openfeature.flag_variants
    FOR EACH ROW EXECUTE FUNCTION openfeature.set_updated_at();

-- Change notifications (provider listens to refresh its cache)

-- Channel is namespaced to avoid collisions in shared databases.

CREATE FUNCTION openfeature.notify_flag_change() RETURNS TRIGGER AS $$
BEGIN
    NOTIFY openfeature_flag_change;
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
