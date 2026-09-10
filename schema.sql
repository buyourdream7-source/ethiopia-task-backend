-- Ethiopia Task — Database Schema (PostgreSQL 14+)
-- Run with: psql $DATABASE_URL -f schema.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone               VARCHAR(20) UNIQUE NOT NULL,       -- e.g. +251912345678
  email               VARCHAR(255) UNIQUE,
  password_hash       TEXT NOT NULL,
  full_name           VARCHAR(150) NOT NULL,
  role                VARCHAR(20) NOT NULL DEFAULT 'customer'
                        CHECK (role IN ('customer', 'worker', 'admin')),
  preferred_language  VARCHAR(5) NOT NULL DEFAULT 'en'
                        CHECK (preferred_language IN ('en', 'am')),
  profile_photo_url   TEXT,
  is_phone_verified   BOOLEAN NOT NULL DEFAULT false,
  is_suspended        BOOLEAN NOT NULL DEFAULT false,
  subscription_active BOOLEAN NOT NULL DEFAULT false,  -- customers get 3 free confirmed jobs, then need this true to book more
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_role ON users(role);

-- ============================================================
-- ADDRESSES (customer saved locations)
-- ============================================================
CREATE TABLE addresses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       VARCHAR(50),              -- "Home", "Office"
  city        VARCHAR(100) NOT NULL DEFAULT 'Addis Ababa',
  subcity     VARCHAR(100),             -- e.g. Bole, Kirkos
  area_text   TEXT NOT NULL,            -- free-text local description
  latitude    NUMERIC(9,6) NOT NULL,
  longitude   NUMERIC(9,6) NOT NULL,
  is_default  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_addresses_user ON addresses(user_id);

-- ============================================================
-- CATEGORIES
-- ============================================================
CREATE TABLE categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        VARCHAR(50) UNIQUE NOT NULL,
  name_en     VARCHAR(100) NOT NULL,
  name_am     VARCHAR(100),
  icon_key    VARCHAR(50),
  parent_slug VARCHAR(50) REFERENCES categories(slug),
  requires_license BOOLEAN NOT NULL DEFAULT false,
  pricing_type VARCHAR(10) NOT NULL DEFAULT 'variable' CHECK (pricing_type IN ('fixed', 'variable')),
  inspection_fee NUMERIC(10,2) NOT NULL DEFAULT 100,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- WORKER PROFILES
-- ============================================================
CREATE TABLE worker_profiles (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bio                      TEXT,
  years_experience         INT DEFAULT 0,
  motivation               TEXT,                  -- "Why do you want to work on this platform?"
  has_own_tools            BOOLEAN,                -- Does the worker bring their own tools/equipment?
  service_radius_km        NUMERIC(5,2) DEFAULT 10,
  base_latitude            NUMERIC(9,6),
  base_longitude           NUMERIC(9,6),
  bank_code                VARCHAR(20),
  bank_name                VARCHAR(100),
  account_number           VARCHAR(50),
  account_name             VARCHAR(150),
  chapa_subaccount_id      VARCHAR(100),           -- set once their bank details are saved and Chapa confirms the subaccount
  verification_status      VARCHAR(20) NOT NULL DEFAULT 'unverified'
                             CHECK (verification_status IN ('unverified', 'pending', 'verified', 'rejected')),
  is_available             BOOLEAN NOT NULL DEFAULT true,
  average_rating           NUMERIC(3,2) NOT NULL DEFAULT 0,
  total_reviews            INT NOT NULL DEFAULT 0,
  total_jobs_completed     INT NOT NULL DEFAULT 0,
  response_rate            NUMERIC(5,2) DEFAULT 100,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_worker_profiles_verification ON worker_profiles(verification_status);
CREATE INDEX idx_worker_profiles_location ON worker_profiles(base_latitude, base_longitude);

-- Many-to-many: a worker can offer several categories, each with its own price band
CREATE TABLE worker_categories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id     UUID NOT NULL REFERENCES worker_profiles(id) ON DELETE CASCADE,
  category_id   UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  price_min     NUMERIC(10,2) NOT NULL,
  price_max     NUMERIC(10,2) NOT NULL,
  UNIQUE(worker_id, category_id)
);

CREATE INDEX idx_worker_categories_category ON worker_categories(category_id);

-- ============================================================
-- VERIFICATION DOCUMENTS (never exposed publicly)
-- ============================================================
CREATE TABLE verification_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id     UUID NOT NULL REFERENCES worker_profiles(id) ON DELETE CASCADE,
  doc_type      VARCHAR(30) NOT NULL CHECK (doc_type IN ('national_id', 'license', 'certificate', 'other')),
  file_url      TEXT NOT NULL,              -- private storage path, never public
  status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by   UUID REFERENCES users(id),
  reviewed_at   TIMESTAMPTZ,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_verification_docs_worker ON verification_documents(worker_id);
CREATE INDEX idx_verification_docs_status ON verification_documents(status);

-- ============================================================
-- PLATFORM SETTINGS (admin-configurable, e.g. commission rate)
-- ============================================================
CREATE TABLE platform_settings (
  key         VARCHAR(50) PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID REFERENCES users(id)
);

INSERT INTO platform_settings (key, value) VALUES ('commission_rate', '0.10');
INSERT INTO platform_settings (key, value) VALUES ('subscription_price_etb', '811.75');

-- ============================================================
-- BOOKINGS
-- ============================================================
CREATE TABLE bookings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id         UUID NOT NULL REFERENCES users(id),
  worker_id           UUID NOT NULL REFERENCES worker_profiles(id),
  category_id         UUID NOT NULL REFERENCES categories(id),
  status              VARCHAR(20) NOT NULL DEFAULT 'pending_payment'
                        CHECK (status IN ('pending_payment', 'requested', 'accepted', 'on_the_way', 'started',
                                           'quote_sent', 'quote_approved', 'pending_final_payment', 'in_progress',
                                           'completed', 'confirmed', 'cancelled', 'disputed')),
  pricing_type         VARCHAR(10) NOT NULL DEFAULT 'variable' CHECK (pricing_type IN ('fixed', 'variable')),
  scheduled_at         TIMESTAMPTZ,
  address_text         TEXT NOT NULL,
  latitude             NUMERIC(9,6),
  longitude            NUMERIC(9,6),
  price_quoted         NUMERIC(10,2) NOT NULL,
  price_final          NUMERIC(10,2),
  price_locked         BOOLEAN NOT NULL DEFAULT false,  -- true once no one (incl. the worker) can change price_final
  inspection_fee_amount NUMERIC(10,2),
  quote_amount          NUMERIC(10,2),
  quote_labor_amount    NUMERIC(10,2),
  quote_materials_amount NUMERIC(10,2),
  quote_note            TEXT,
  quote_status          VARCHAR(20) CHECK (quote_status IN ('pending', 'approved', 'rejected')),
  quote_submitted_at    TIMESTAMPTZ,
  quote_approved_at     TIMESTAMPTZ,
  commission_rate      NUMERIC(5,4),          -- snapshot at time of completion
  commission_amount    NUMERIC(10,2),
  worker_earnings      NUMERIC(10,2),
  cancellation_reason  TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bookings_customer ON bookings(customer_id);
CREATE INDEX idx_bookings_worker ON bookings(worker_id);
CREATE INDEX idx_bookings_status ON bookings(status);

-- Immutable audit trail of every status change
CREATE TABLE booking_status_history (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  status       VARCHAR(20) NOT NULL,
  changed_by   UUID REFERENCES users(id),
  note         TEXT,
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_booking_history_booking ON booking_status_history(booking_id);

-- ============================================================
-- PAYMENTS
-- ============================================================
CREATE TABLE payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id          UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  payment_type        VARCHAR(20) NOT NULL DEFAULT 'full_payment'
                        CHECK (payment_type IN ('inspection_fee', 'full_payment', 'final_payment')),
  amount              NUMERIC(10,2) NOT NULL,
  status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
  provider             VARCHAR(30),           -- 'chapa', 'manual', etc.
  provider_reference   VARCHAR(255),
  tx_ref               VARCHAR(100) UNIQUE,   -- our own reference sent to the payment provider
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payments_booking ON payments(booking_id);

-- ============================================================
-- REVIEWS
-- ============================================================
CREATE TABLE reviews (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   UUID UNIQUE NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  customer_id  UUID NOT NULL REFERENCES users(id),
  worker_id    UUID NOT NULL REFERENCES worker_profiles(id),
  rating       INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_reviews_worker ON reviews(worker_id);

-- ============================================================
-- DISPUTES
-- ============================================================
CREATE TABLE disputes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  raised_by        UUID NOT NULL REFERENCES users(id),
  reason           TEXT NOT NULL,
  status           VARCHAR(20) NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'investigating', 'resolved', 'dismissed')),
  resolution_note  TEXT,
  resolved_by      UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at      TIMESTAMPTZ
);

CREATE INDEX idx_disputes_status ON disputes(status);

-- ============================================================
-- MESSAGING
-- ============================================================
CREATE TABLE conversations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   UUID REFERENCES bookings(id) ON DELETE CASCADE,
  customer_id  UUID NOT NULL REFERENCES users(id),
  worker_id    UUID NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id        UUID NOT NULL REFERENCES users(id),
  content          TEXT NOT NULL,
  is_read          BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================
CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        VARCHAR(50) NOT NULL,
  title       VARCHAR(200) NOT NULL,
  body        TEXT,
  is_read     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_user ON notifications(user_id, is_read);

-- ============================================================
-- SEED CATEGORIES
-- ============================================================
INSERT INTO categories (slug, name_en, name_am, icon_key, sort_order, requires_license, pricing_type) VALUES
  ('electrician', 'Electrician', 'ኤሌክትሪክ', 'zap', 1, true, 'variable'),
  ('plumber', 'Plumber', 'ቧንቧ', 'droplets', 2, true, 'variable'),
  ('mechanic', 'Mechanic', 'መካኒክ', 'car', 3, true, 'variable'),
  ('cleaner', 'Cleaner', 'ጽዳት', 'sparkles', 4, false, 'fixed'),
  ('phone_repair', 'Phone Repair', 'ስልክ ጥገና', 'smartphone', 5, false, 'fixed'),
  ('computer_repair', 'Computer Repair', 'ኮምፒዩተር ጥገና', 'monitor', 6, false, 'fixed'),
  ('tutor', 'Tutor', 'ትምህርት', 'graduation-cap', 7, false, 'fixed'),
  ('photographer', 'Photographer', 'ፎቶግራፍ', 'camera', 8, false, 'fixed'),
  ('graphic_design', 'Graphic Design', 'ግራፊክ ዲዛይን', 'pen-tool', 9, false, 'fixed'),
  ('video_editor', 'Video Editor', 'ቪዲዮ አርታኢ', 'video', 10, false, 'fixed'),
  ('construction', 'Construction', 'ግንባታ', 'hard-hat', 11, true, 'variable'),
  ('moving', 'Moving Services', 'ማዛወሪያ', 'truck', 12, false, 'fixed'),
  ('personal_trainer', 'Personal Trainer', 'የግል አሰልጣኝ', 'dumbbell', 13, true, 'fixed'),
  ('teacher', 'Teacher', 'መምህር', 'graduation-cap', 14, true, 'fixed');
