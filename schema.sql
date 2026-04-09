CREATE SCHEMA openfeature;

-- Must match FlagData.flagType in provider.ts.
CREATE TYPE openfeature.flag_type AS ENUM (
    'boolean',
    'string',
    'number',
    'object'
);

CREATE TABLE openfeature.feature_flags (
    flag_key varchar(255) PRIMARY KEY CHECK (flag_key <> ''),
    flag_type openfeature.flag_type NOT NULL,
    enabled boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    -- Required by the compound FK from flag_variants.
    UNIQUE (flag_key, flag_type)
);

CREATE TABLE openfeature.flag_variants (
    flag_key varchar(255) NOT NULL CHECK (flag_key <> ''),
    variant varchar(255) NOT NULL CHECK (variant <> ''),
    flag_type openfeature.flag_type NOT NULL,
    value jsonb NOT NULL,
    percentage integer CHECK (percentage IS NULL OR percentage BETWEEN 0 AND 100),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (jsonb_typeof(value) = flag_type::text),
    PRIMARY KEY (flag_key, variant),
    FOREIGN KEY (flag_key, flag_type) REFERENCES openfeature.feature_flags (flag_key, flag_type)
);

COMMENT ON COLUMN openfeature.flag_variants.percentage IS 'NULL = default/fallback variant, 0-100 = rollout participant';

CREATE UNIQUE INDEX one_default_per_flag ON openfeature.flag_variants (flag_key)
WHERE
    percentage IS NULL;

CREATE TABLE openfeature.flag_evaluations (
    flag_key varchar(255) PRIMARY KEY
        REFERENCES openfeature.feature_flags (flag_key) ON DELETE CASCADE,
    last_evaluated_at timestamptz NOT NULL DEFAULT now()
);

-- Automatic updated_at
CREATE FUNCTION openfeature.set_updated_at ()
    RETURNS TRIGGER
    AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$
LANGUAGE plpgsql;

CREATE TRIGGER feature_flags_set_updated_at
    BEFORE UPDATE ON openfeature.feature_flags
    FOR EACH ROW
    EXECUTE FUNCTION openfeature.set_updated_at ();

CREATE TRIGGER flag_variants_set_updated_at
    BEFORE UPDATE ON openfeature.flag_variants
    FOR EACH ROW
    EXECUTE FUNCTION openfeature.set_updated_at ();

-- Change notifications
CREATE FUNCTION openfeature.notify_flag_change ()
    RETURNS TRIGGER
    AS $$
BEGIN
    NOTIFY openfeature_flag_change;
    RETURN NULL;
END;
$$
LANGUAGE plpgsql;

CREATE TRIGGER feature_flags_notify
    AFTER INSERT OR UPDATE OR DELETE ON openfeature.feature_flags
    FOR EACH STATEMENT
    EXECUTE FUNCTION openfeature.notify_flag_change ();

CREATE TRIGGER flag_variants_notify
    AFTER INSERT OR UPDATE OR DELETE ON openfeature.flag_variants
    FOR EACH STATEMENT
    EXECUTE FUNCTION openfeature.notify_flag_change ();
