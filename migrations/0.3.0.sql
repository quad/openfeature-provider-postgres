CREATE SCHEMA openfeature;

CREATE TYPE openfeature.flag_type AS ENUM (
    'boolean',
    'string',
    'number',
    'object'
);

CREATE TABLE openfeature.flags (
    flag_key varchar(255) PRIMARY KEY CHECK (flag_key <> ''),
    flag_type openfeature.flag_type NOT NULL,
    enabled boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    -- Required by the compound FK from flag_variants and flag_targeting.
    UNIQUE (flag_key, flag_type)
);

CREATE TABLE openfeature.flag_variants (
    flag_key varchar(255) NOT NULL,
    variant varchar(255) NOT NULL CHECK (variant <> ''),
    flag_type openfeature.flag_type NOT NULL,
    value jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (jsonb_typeof(value) = flag_type::text),
    PRIMARY KEY (flag_key, variant),
    FOREIGN KEY (flag_key, flag_type) REFERENCES openfeature.flags (flag_key, flag_type)
);

CREATE TABLE openfeature.flag_targeting (
    flag_key varchar(255) NOT NULL,
    subject varchar(255) CHECK (subject IS NULL OR subject <> ''),
    flag_type openfeature.flag_type NOT NULL,
    variant varchar(255) NOT NULL,
    weight integer NOT NULL CHECK (weight >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (flag_key, subject, variant),
    FOREIGN KEY (flag_key, flag_type) REFERENCES openfeature.flags (flag_key, flag_type),
    FOREIGN KEY (flag_key, variant) REFERENCES openfeature.flag_variants (flag_key, variant)
);

COMMENT ON COLUMN openfeature.flag_targeting.subject IS 'EvaluationContext.targetingKey to match. NULL is the flag-wide default cohort.';
COMMENT ON COLUMN openfeature.flag_targeting.weight IS 'Proportional traffic weight, normalized by sum within the same (flag_key, subject).';

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

CREATE TRIGGER flags_set_updated_at
    BEFORE UPDATE ON openfeature.flags
    FOR EACH ROW
    EXECUTE FUNCTION openfeature.set_updated_at ();

CREATE TRIGGER flag_variants_set_updated_at
    BEFORE UPDATE ON openfeature.flag_variants
    FOR EACH ROW
    EXECUTE FUNCTION openfeature.set_updated_at ();

CREATE TRIGGER flag_targeting_set_updated_at
    BEFORE UPDATE ON openfeature.flag_targeting
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

CREATE TRIGGER flags_notify
    AFTER INSERT OR UPDATE OR DELETE ON openfeature.flags
    FOR EACH STATEMENT
    EXECUTE FUNCTION openfeature.notify_flag_change ();

CREATE TRIGGER flag_variants_notify
    AFTER INSERT OR UPDATE OR DELETE ON openfeature.flag_variants
    FOR EACH STATEMENT
    EXECUTE FUNCTION openfeature.notify_flag_change ();

CREATE TRIGGER flag_targeting_notify
    AFTER INSERT OR UPDATE OR DELETE ON openfeature.flag_targeting
    FOR EACH STATEMENT
    EXECUTE FUNCTION openfeature.notify_flag_change ();
