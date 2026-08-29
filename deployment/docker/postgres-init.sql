-- Minimal local schema required before the API's idempotent startup migrations
-- run. Feature-specific tables are created by the FastAPI lifespan hooks.

CREATE TABLE IF NOT EXISTS monitored_jobs (
    job_id TEXT PRIMARY KEY,
    jobdiva_id TEXT,
    title TEXT NOT NULL DEFAULT '',
    enhanced_title TEXT,
    customer_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'OPEN',
    city TEXT,
    state TEXT,
    zip_code TEXT,
    location_type TEXT,
    jobdiva_description TEXT,
    ai_description TEXT,
    recruiter_notes TEXT,
    employment_type TEXT,
    pay_rate TEXT,
    openings TEXT,
    work_authorization TEXT,
    posted_date TEXT,
    start_date TEXT,
    priority TEXT,
    program_duration TEXT,
    max_allowed_submittals TEXT,
    processing_status TEXT NOT NULL DEFAULT 'pending',
    processing_stage TEXT,
    screening_level TEXT,
    selected_job_boards TEXT NOT NULL DEFAULT '[]',
    selected_employment_types TEXT NOT NULL DEFAULT '[]',
    recruiter_emails TEXT NOT NULL DEFAULT '[]',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_monitored_jobs_jobdiva_id_bootstrap
    ON monitored_jobs (jobdiva_id);

ALTER TABLE monitored_jobs
    ADD COLUMN IF NOT EXISTS domains JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Create this before the API starts: the startup metrics backfill reads it
-- before the service's later schema hook would otherwise create it.
CREATE TABLE IF NOT EXISTS sourced_candidates (
    id SERIAL PRIMARY KEY,
    jobdiva_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    source TEXT NOT NULL,
    name TEXT,
    email TEXT,
    phone TEXT,
    headline TEXT,
    location TEXT,
    resume_id TEXT,
    resume_text TEXT,
    profile_url TEXT,
    image_url TEXT,
    data JSONB,
    status TEXT DEFAULT 'sourced',
    resume_match_percentage INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (jobdiva_id, candidate_id, source)
);

-- Rubric tables predate the API's idempotent column/index migrations. A fresh
-- local database needs their base shape so the startup migration can run.
CREATE TABLE IF NOT EXISTS job_skills (
    id SERIAL PRIMARY KEY,
    jobdiva_id TEXT NOT NULL,
    skill_name TEXT NOT NULL,
    min_years NUMERIC DEFAULT 0,
    recent BOOLEAN DEFAULT FALSE,
    match_type TEXT,
    is_required BOOLEAN DEFAULT FALSE,
    category TEXT,
    similar_skills TEXT[] DEFAULT '{}',
    source TEXT
);

CREATE TABLE IF NOT EXISTS job_titles (
    id SERIAL PRIMARY KEY,
    jobdiva_id TEXT NOT NULL,
    title TEXT NOT NULL,
    min_years NUMERIC DEFAULT 0,
    recent BOOLEAN DEFAULT FALSE,
    match_type TEXT,
    is_required BOOLEAN DEFAULT FALSE,
    similar_titles TEXT[] DEFAULT '{}',
    source TEXT
);

CREATE TABLE IF NOT EXISTS job_education (
    id SERIAL PRIMARY KEY,
    jobdiva_id TEXT NOT NULL,
    degree TEXT,
    field TEXT,
    is_required BOOLEAN DEFAULT FALSE,
    source TEXT
);

CREATE TABLE IF NOT EXISTS job_customer_requirements (
    id SERIAL PRIMARY KEY,
    jobdiva_id TEXT NOT NULL,
    requirement TEXT NOT NULL,
    is_required BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS job_other_requirements (
    id SERIAL PRIMARY KEY,
    jobdiva_id TEXT NOT NULL,
    requirement TEXT NOT NULL,
    is_required BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS job_screen_questions (
    id SERIAL PRIMARY KEY,
    jobdiva_id TEXT NOT NULL,
    question_text TEXT NOT NULL,
    pass_criteria TEXT,
    is_default BOOLEAN DEFAULT FALSE,
    category TEXT,
    order_index INTEGER DEFAULT 0,
    is_hard_filter BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS user_roles (
    email TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO user_roles (email, role)
VALUES ('developer@pair.local', 'admin')
ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role;
