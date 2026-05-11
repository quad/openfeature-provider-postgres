-- 0.2.0 -> 0.3.0
--
-- Introduces openfeature.flag_targeting (weighted variant distributions
-- keyed by subject; the null subject is the flag-wide default cohort) and
-- removes openfeature.flag_variants.weight. Each existing variant row
-- becomes one default-cohort row in flag_targeting, preserving the
-- pre-migration weighted-hash outcome.

BEGIN;

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

CREATE TRIGGER flag_targeting_set_updated_at
    BEFORE UPDATE ON openfeature.flag_targeting
    FOR EACH ROW
    EXECUTE FUNCTION openfeature.set_updated_at ();

CREATE TRIGGER flag_targeting_notify
    AFTER INSERT OR UPDATE OR DELETE ON openfeature.flag_targeting
    FOR EACH STATEMENT
    EXECUTE FUNCTION openfeature.notify_flag_change ();

INSERT INTO openfeature.flag_targeting (flag_key, subject, flag_type, variant, weight)
SELECT flag_key, NULL, flag_type, variant, weight
FROM openfeature.flag_variants;

ALTER TABLE openfeature.flag_variants DROP COLUMN weight;

-- The CHECK (flag_key <> '') on flag_variants.flag_key is redundant given
-- the FK to flags(flag_key, flag_type) and the matching CHECK on
-- flags.flag_key. The new schema drops it; the migration follows suit.
ALTER TABLE openfeature.flag_variants DROP CONSTRAINT flag_variants_flag_key_check;

COMMIT;
