-- AI Engagement Center — core schema (SQLite dialect; see docs/ARCHITECTURE.md for the PostgreSQL mapping)
PRAGMA foreign_keys = ON;

CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE roles (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT);
CREATE TABLE permissions (role_id TEXT NOT NULL REFERENCES roles(id), permission TEXT NOT NULL, PRIMARY KEY (role_id, permission));

CREATE TABLE users (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), email TEXT NOT NULL, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, role_id TEXT NOT NULL REFERENCES roles(id), status TEXT NOT NULL DEFAULT 'active',
  language TEXT NOT NULL DEFAULT 'en', created_at TEXT NOT NULL, UNIQUE (org_id, email)
);
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, expires_at TEXT NOT NULL);

-- ───────── CDP ─────────
CREATE TABLE customers (
  player_id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id),
  display_name TEXT NOT NULL, email TEXT, phone TEXT, birth_date TEXT, age INTEGER, gender TEXT,
  country TEXT, city TEXT, language TEXT, registered_at TEXT NOT NULL, lifecycle_stage TEXT NOT NULL,
  kyc_status TEXT NOT NULL, kyc_updated_at TEXT, kyc_failure_reason TEXT, vip_tier TEXT NOT NULL,
  primary_platform TEXT, device_type TEXT, os TEXT, app_version TEXT,
  last_active_at TEXT, last_login_at TEXT, account_status TEXT NOT NULL DEFAULT 'active',
  risk_level TEXT NOT NULL DEFAULT 'low', self_excluded INTEGER NOT NULL DEFAULT 0, rg_restricted INTEGER NOT NULL DEFAULT 0,
  marketing_opt_out INTEGER NOT NULL DEFAULT 0,
  -- restricted financial aggregates (field-level permission: finance.read)
  deposit_count INTEGER NOT NULL DEFAULT 0, deposit_total REAL NOT NULL DEFAULT 0, withdrawal_total REAL NOT NULL DEFAULT 0,
  -- gaming aggregates (non-restricted, experience oriented)
  gaming_sessions_30d INTEGER NOT NULL DEFAULT 0, gaming_active_days_30d INTEGER NOT NULL DEFAULT 0,
  avg_session_minutes REAL NOT NULL DEFAULT 0, favorite_category TEXT, favorite_provider_id TEXT,
  launch_success_7d INTEGER NOT NULL DEFAULT 0, launch_failures_7d INTEGER NOT NULL DEFAULT 0,
  avg_load_ms INTEGER NOT NULL DEFAULT 0, search_no_result_7d INTEGER NOT NULL DEFAULT 0,
  open_tickets INTEGER NOT NULL DEFAULT 0, tickets_30d INTEGER NOT NULL DEFAULT 0, csat REAL,
  first_game_at TEXT, last_game_at TEXT, profile_completeness REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_customers_org_stage ON customers(org_id, lifecycle_stage);
CREATE INDEX idx_customers_kyc ON customers(org_id, kyc_status);
CREATE INDEX idx_customers_last_active ON customers(org_id, last_active_at);

CREATE TABLE customer_identities (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, player_id TEXT NOT NULL REFERENCES customers(player_id),
  identity_type TEXT NOT NULL, identity_value TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 1, source TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (org_id, identity_type, identity_value)
);
CREATE INDEX idx_identities_player ON customer_identities(player_id);
CREATE TABLE identity_merge_candidates (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, identity_type TEXT NOT NULL, identity_value TEXT NOT NULL,
  candidate_player_id TEXT NOT NULL, matched_player_id TEXT, match_reason TEXT, confidence REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', decided_by TEXT, decided_at TEXT, created_at TEXT NOT NULL
);

CREATE TABLE customer_attribute_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL, attribute TEXT NOT NULL, old_value TEXT, new_value TEXT,
  source TEXT NOT NULL, changed_at TEXT NOT NULL
);
CREATE INDEX idx_attr_hist_player ON customer_attribute_history(player_id, changed_at);

CREATE TABLE consent_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL REFERENCES customers(player_id), channel TEXT NOT NULL,
  purpose TEXT NOT NULL, granted INTEGER NOT NULL, source TEXT NOT NULL, recorded_at TEXT NOT NULL
);
CREATE INDEX idx_consent_player ON consent_records(player_id, channel, purpose, recorded_at);
-- current consent snapshot (latest record per player/channel/purpose)
CREATE TABLE consent_current (
  player_id TEXT NOT NULL, channel TEXT NOT NULL, purpose TEXT NOT NULL, granted INTEGER NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (player_id, channel, purpose)
);

CREATE TABLE exclusion_records (
  id TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES customers(player_id), exclusion_type TEXT NOT NULL,
  reason TEXT, source TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, ended_at TEXT
);
CREATE INDEX idx_exclusion_player ON exclusion_records(player_id, active);

-- ───────── Gaming catalogue / events ─────────
CREATE TABLE gaming_providers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, region TEXT, status TEXT NOT NULL DEFAULT 'operational',
  integration_type TEXT, sla_launch_success REAL NOT NULL DEFAULT 0.98, created_at TEXT NOT NULL
);
CREATE TABLE games (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES gaming_providers(id), name TEXT NOT NULL,
  category TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'live', released_at TEXT, popularity REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_games_provider ON games(provider_id);

CREATE TABLE event_definitions (
  name TEXT PRIMARY KEY, category TEXT NOT NULL, description TEXT, version INTEGER NOT NULL DEFAULT 1,
  required_attributes TEXT NOT NULL DEFAULT '[]', restricted INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE TABLE event_definition_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, version INTEGER NOT NULL, snapshot TEXT NOT NULL, changed_by TEXT, changed_at TEXT NOT NULL
);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, org_id TEXT NOT NULL, event_name TEXT NOT NULL,
  category TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, player_id TEXT, game_id TEXT, provider_id TEXT, session_id TEXT,
  event_time TEXT NOT NULL, entry_source TEXT, platform TEXT, device_type TEXT, operating_system TEXT, app_version TEXT,
  loading_duration INTEGER, error_code TEXT, correlation_id TEXT, properties TEXT, source TEXT NOT NULL DEFAULT 'api',
  ingested_at TEXT NOT NULL
);
CREATE INDEX idx_events_player_time ON events(player_id, event_time);
CREATE INDEX idx_events_name_time ON events(event_name, event_time);
CREATE INDEX idx_events_provider_time ON events(provider_id, event_time);
CREATE TABLE event_rejections (
  id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, event_name TEXT, reason TEXT NOT NULL, payload TEXT, at TEXT NOT NULL
);

CREATE TABLE gaming_sessions (
  id TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES customers(player_id), game_id TEXT NOT NULL REFERENCES games(id),
  provider_id TEXT NOT NULL, platform TEXT, started_at TEXT NOT NULL, ended_at TEXT, duration_minutes REAL,
  end_reason TEXT
);
CREATE INDEX idx_gsess_player ON gaming_sessions(player_id, started_at);

-- restricted: betting transactions (permission: gaming_transactions.read)
CREATE TABLE gaming_transactions (
  id TEXT PRIMARY KEY, player_id TEXT NOT NULL, game_id TEXT NOT NULL, provider_id TEXT NOT NULL, session_id TEXT,
  bet_amount REAL NOT NULL, payout REAL NOT NULL, settled_at TEXT NOT NULL
);
CREATE INDEX idx_gtx_player ON gaming_transactions(player_id, settled_at);

CREATE TABLE service_tickets (
  id TEXT PRIMARY KEY, player_id TEXT NOT NULL, category TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal', source TEXT NOT NULL, related_run_id TEXT, created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE INDEX idx_tickets_player ON service_tickets(player_id, status);

-- ───────── Tags / segments ─────────
CREATE TABLE tags (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, tag_type TEXT NOT NULL,
  description TEXT, owner TEXT, refresh_policy TEXT, usage_restriction TEXT, expires_after_days INTEGER,
  rule TEXT, created_at TEXT NOT NULL, UNIQUE (org_id, key)
);
CREATE TABLE customer_tags (
  player_id TEXT NOT NULL REFERENCES customers(player_id), tag_id TEXT NOT NULL REFERENCES tags(id), source TEXT NOT NULL,
  added_at TEXT NOT NULL, expires_at TEXT, PRIMARY KEY (player_id, tag_id)
);
CREATE INDEX idx_ctags_tag ON customer_tags(tag_id);

CREATE TABLE segments (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT, segment_type TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'service', rules TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active',
  refresh_schedule TEXT, member_count INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  last_evaluated_at TEXT, ai_generated INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE segment_versions (
  segment_id TEXT NOT NULL REFERENCES segments(id), version INTEGER NOT NULL, rules TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (segment_id, version)
);
CREATE TABLE segment_memberships (
  segment_id TEXT NOT NULL REFERENCES segments(id), player_id TEXT NOT NULL REFERENCES customers(player_id), joined_at TEXT NOT NULL,
  PRIMARY KEY (segment_id, player_id)
);
CREATE INDEX idx_segmem_player ON segment_memberships(player_id);
CREATE TABLE segment_membership_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, segment_id TEXT NOT NULL, player_id TEXT NOT NULL, action TEXT NOT NULL, reason TEXT, at TEXT NOT NULL
);
CREATE INDEX idx_segmem_hist ON segment_membership_history(segment_id, at);

-- ───────── AI operations ─────────
CREATE TABLE ai_agents (
  key TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, enabled INTEGER NOT NULL DEFAULT 1, model TEXT,
  allowed_tools TEXT NOT NULL DEFAULT '[]', config TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
);
CREATE TABLE ai_workflows (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, scenario TEXT NOT NULL, strategy_category TEXT NOT NULL,
  definition TEXT NOT NULL, schedule_cron TEXT, default_mode TEXT NOT NULL DEFAULT 'manual', enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE opportunities (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT, category TEXT NOT NULL, detected_at TEXT NOT NULL,
  severity TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '[]', affected_users INTEGER NOT NULL DEFAULT 0, affected_systems TEXT NOT NULL DEFAULT '[]',
  possible_causes TEXT NOT NULL DEFAULT '[]', recommended_actions TEXT NOT NULL DEFAULT '[]', estimated_impact TEXT,
  risk_class TEXT NOT NULL DEFAULT 'low', status TEXT NOT NULL DEFAULT 'new', workflow_id TEXT, run_id TEXT,
  strategy_id TEXT, strategy_version INTEGER, dedupe_key TEXT UNIQUE, updated_at TEXT NOT NULL
);
CREATE INDEX idx_opps_status ON opportunities(status, detected_at);

CREATE TABLE ai_workflow_runs (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES ai_workflows(id), opportunity_id TEXT, status TEXT NOT NULL,
  mode TEXT NOT NULL, simulation INTEGER NOT NULL DEFAULT 0, trigger TEXT NOT NULL, strategy_id TEXT, strategy_version INTEGER,
  current_node TEXT, context TEXT NOT NULL DEFAULT '{}', error TEXT, tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0,
  replay_of TEXT, started_by TEXT, started_at TEXT NOT NULL, finished_at TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX idx_runs_status ON ai_workflow_runs(status, started_at);
CREATE TABLE ai_node_executions (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES ai_workflow_runs(id), node_key TEXT NOT NULL, agent_key TEXT NOT NULL,
  status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1, input TEXT, output TEXT, summary TEXT, evidence TEXT, error TEXT,
  confidence REAL, tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, started_at TEXT, finished_at TEXT, duration_ms INTEGER,
  UNIQUE (run_id, node_key)
);
CREATE TABLE ai_tool_calls (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_key TEXT NOT NULL, tool TEXT NOT NULL, args TEXT, result_summary TEXT,
  status TEXT NOT NULL, duration_ms INTEGER, at TEXT NOT NULL
);
CREATE INDEX idx_toolcalls_run ON ai_tool_calls(run_id);
-- ordered, replayable stream of everything that happens (SSE source of truth)
CREATE TABLE stream_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL, ref_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX idx_stream_topic ON stream_events(topic, seq);
CREATE INDEX idx_stream_ref ON stream_events(ref_id, seq);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY, run_id TEXT, opportunity_id TEXT, action_type TEXT NOT NULL, proposal TEXT NOT NULL, risk TEXT NOT NULL,
  mode TEXT NOT NULL, policy_result TEXT, status TEXT NOT NULL, approval_id TEXT, decided_by TEXT, decided_at TEXT, created_at TEXT NOT NULL
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, title TEXT NOT NULL, summary TEXT,
  evidence TEXT NOT NULL DEFAULT '[]', risk TEXT NOT NULL DEFAULT 'medium', status TEXT NOT NULL DEFAULT 'pending',
  required_levels INTEGER NOT NULL DEFAULT 1, current_level INTEGER NOT NULL DEFAULT 1, requested_by TEXT NOT NULL,
  expires_at TEXT, created_at TEXT NOT NULL, decided_at TEXT
);
CREATE INDEX idx_approvals_status ON approvals(status, created_at);
CREATE TABLE approval_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, approval_id TEXT NOT NULL REFERENCES approvals(id), level INTEGER NOT NULL, action TEXT NOT NULL,
  actor TEXT NOT NULL, comment TEXT, at TEXT NOT NULL
);

-- ───────── Offers / entitlements ─────────
CREATE TABLE offers (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, description TEXT,
  base_amount REAL NOT NULL, unit TEXT NOT NULL DEFAULT 'PHP', eligibility TEXT NOT NULL DEFAULT '{}',
  validity_days INTEGER NOT NULL DEFAULT 14, redemption_conditions TEXT, distribution_limit INTEGER, per_user_limit INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft', version INTEGER NOT NULL DEFAULT 1, requires_approval INTEGER NOT NULL DEFAULT 1,
  allow_personalization INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE offer_versions (offer_id TEXT NOT NULL, version INTEGER NOT NULL, snapshot TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL, PRIMARY KEY (offer_id, version));
CREATE TABLE offer_budgets (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, scope TEXT NOT NULL, offer_id TEXT, campaign_id TEXT,
  total REAL NOT NULL, reserved REAL NOT NULL DEFAULT 0, spent REAL NOT NULL DEFAULT 0, daily_limit REAL,
  period_start TEXT NOT NULL, period_end TEXT NOT NULL, created_at TEXT NOT NULL,
  CHECK (reserved >= 0 AND spent >= 0 AND reserved + spent <= total)
);
CREATE TABLE offer_decisions (
  id TEXT PRIMARY KEY, batch_id TEXT, player_id TEXT NOT NULL, offer_id TEXT NOT NULL, outcome TEXT NOT NULL,
  base_amount REAL NOT NULL, approved_amount REAL NOT NULL, rules_applied TEXT NOT NULL, reason TEXT NOT NULL,
  budget_check TEXT NOT NULL, compliance_check TEXT NOT NULL, strategy_id TEXT, strategy_version INTEGER,
  approval_status TEXT NOT NULL, simulated INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX idx_offer_dec_batch ON offer_decisions(batch_id);
CREATE TABLE offer_transactions (
  id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, decision_id TEXT, player_id TEXT NOT NULL, offer_id TEXT NOT NULL,
  budget_id TEXT, amount REAL NOT NULL, status TEXT NOT NULL, history TEXT NOT NULL DEFAULT '[]', expires_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_offer_tx_player ON offer_transactions(player_id, offer_id, status);
CREATE TABLE duplicate_prevention_log (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, key TEXT NOT NULL, player_id TEXT, at TEXT NOT NULL);

-- ───────── Campaigns / journeys / channels ─────────
CREATE TABLE channels (
  key TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'mock',
  connection_status TEXT NOT NULL DEFAULT 'not_configured', verified_at TEXT, cost_per_message REAL NOT NULL DEFAULT 0,
  retry_policy TEXT NOT NULL DEFAULT '{}', fallback_channels TEXT NOT NULL DEFAULT '[]', consent_channel TEXT NOT NULL,
  restrictions TEXT, health TEXT NOT NULL DEFAULT 'healthy', enabled INTEGER NOT NULL DEFAULT 1, config TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE message_templates (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, channel TEXT NOT NULL, language TEXT NOT NULL, purpose TEXT NOT NULL,
  subject TEXT, body TEXT NOT NULL, variables TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'draft',
  provider_approval TEXT NOT NULL DEFAULT 'not_required', compliance_result TEXT, version INTEGER NOT NULL DEFAULT 1,
  ai_drafted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE template_versions (template_id TEXT NOT NULL, version INTEGER NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(template_id, version));

CREATE TABLE campaigns (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, objective TEXT NOT NULL, purpose TEXT NOT NULL, status TEXT NOT NULL,
  segment_id TEXT, channels TEXT NOT NULL DEFAULT '[]', template_id TEXT, offer_id TEXT, schedule_at TEXT, timezone TEXT NOT NULL DEFAULT 'Asia/Manila',
  budget REAL NOT NULL DEFAULT 0, ab_test TEXT, approval_id TEXT, version INTEGER NOT NULL DEFAULT 1, strategy_id TEXT, strategy_version INTEGER,
  stats TEXT NOT NULL DEFAULT '{}', created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE campaign_versions (campaign_id TEXT NOT NULL, version INTEGER NOT NULL, snapshot TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL, PRIMARY KEY(campaign_id, version));

CREATE TABLE journeys (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT, purpose TEXT NOT NULL DEFAULT 'service',
  status TEXT NOT NULL DEFAULT 'draft', draft_definition TEXT NOT NULL, published_version INTEGER, strategy_category TEXT,
  created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE journey_versions (
  journey_id TEXT NOT NULL REFERENCES journeys(id), version INTEGER NOT NULL, definition TEXT NOT NULL, strategy_id TEXT, strategy_version INTEGER,
  status TEXT NOT NULL, approval_id TEXT, published_by TEXT, published_at TEXT, PRIMARY KEY (journey_id, version)
);
CREATE TABLE journey_executions (
  id TEXT PRIMARY KEY, journey_id TEXT NOT NULL, version INTEGER NOT NULL, player_id TEXT NOT NULL, status TEXT NOT NULL,
  current_node TEXT, wake_at TEXT, strategy_version INTEGER, history TEXT NOT NULL DEFAULT '[]', exit_reason TEXT,
  started_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (journey_id, player_id, version)
);
CREATE INDEX idx_jexec_status ON journey_executions(status, wake_at);
CREATE TABLE journey_node_stats (journey_id TEXT NOT NULL, version INTEGER NOT NULL, node_id TEXT NOT NULL, entered INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (journey_id, version, node_id));

CREATE TABLE messages (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, player_id TEXT NOT NULL, channel TEXT NOT NULL,
  template_id TEXT, purpose TEXT NOT NULL, campaign_id TEXT, journey_id TEXT, run_id TEXT, variant TEXT, status TEXT NOT NULL,
  cost REAL NOT NULL DEFAULT 0, error_code TEXT, simulated INTEGER NOT NULL DEFAULT 1, body_preview TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_messages_player ON messages(player_id, created_at);
CREATE INDEX idx_messages_campaign ON messages(campaign_id);
CREATE INDEX idx_messages_channel_time ON messages(channel, created_at);
CREATE TABLE delivery_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL REFERENCES messages(id), status TEXT NOT NULL, error_code TEXT,
  provider_ref TEXT, at TEXT NOT NULL, UNIQUE (message_id, status)
);

-- ───────── Strategy / experiments ─────────
CREATE TABLE strategies (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL UNIQUE, objective TEXT NOT NULL,
  primary_metric TEXT NOT NULL, metric_direction TEXT NOT NULL DEFAULT 'up', active_version INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE strategy_versions (
  id TEXT PRIMARY KEY, strategy_id TEXT NOT NULL REFERENCES strategies(id), version INTEGER NOT NULL, parent_version INTEGER,
  config TEXT NOT NULL, status TEXT NOT NULL, baseline_metrics TEXT, candidate_metrics TEXT, experiment_id TEXT,
  change_summary TEXT, risk_assessment TEXT, effective_at TEXT, rollback_version INTEGER, approval_id TEXT,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (strategy_id, version)
);
CREATE TABLE strategy_evaluations (
  id TEXT PRIMARY KEY, strategy_id TEXT NOT NULL, version INTEGER NOT NULL, run_id TEXT, metrics TEXT NOT NULL, verdict TEXT NOT NULL,
  notes TEXT, at TEXT NOT NULL
);
CREATE TABLE experiments (
  id TEXT PRIMARY KEY, strategy_id TEXT NOT NULL, name TEXT NOT NULL, control_version INTEGER NOT NULL, candidate_version INTEGER NOT NULL,
  allocation REAL NOT NULL DEFAULT 0.5, metric TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT
);
CREATE TABLE experiment_results (
  experiment_id TEXT NOT NULL REFERENCES experiments(id), variant TEXT NOT NULL, sample_size INTEGER NOT NULL, successes INTEGER NOT NULL,
  rate REAL NOT NULL, ci_low REAL, ci_high REAL, p_value REAL, PRIMARY KEY (experiment_id, variant)
);

-- ───────── Compliance / audit ─────────
CREATE TABLE compliance_policies (
  key TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, mandatory INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL DEFAULT '{}', updated_by TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE compliance_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, context TEXT NOT NULL, ref_id TEXT, player_id TEXT, purpose TEXT, channel TEXT,
  allowed INTEGER NOT NULL, reasons TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX idx_compliance_checks_at ON compliance_checks(at);

CREATE TABLE audit_logs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, org_id TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL,
  entity_type TEXT, entity_id TEXT, details TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;

-- ───────── Settings / integrations ─────────
CREATE TABLE data_sources (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, source_type TEXT NOT NULL, kind TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'mock',
  status TEXT NOT NULL, last_sync_at TEXT, records INTEGER NOT NULL DEFAULT 0, freshness_minutes INTEGER, config TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE webhooks (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, url TEXT NOT NULL, events TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
  secret_ref TEXT NOT NULL, created_at TEXT NOT NULL, last_delivery_status TEXT
);
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, prefix TEXT NOT NULL, key_hash TEXT NOT NULL, scopes TEXT NOT NULL,
  created_by TEXT, created_at TEXT NOT NULL, revoked_at TEXT
);
CREATE TABLE ai_providers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, provider_type TEXT NOT NULL, base_url TEXT, model TEXT, env_key TEXT, enabled INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL);
CREATE TABLE feature_flags (key TEXT PRIMARY KEY, description TEXT, enabled INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, org_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT, link TEXT,
  severity TEXT NOT NULL DEFAULT 'info', read INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL
);
CREATE TABLE copilot_conversations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE copilot_messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES copilot_conversations(id), role TEXT NOT NULL, content TEXT NOT NULL,
  parts TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'complete', provider TEXT, created_at TEXT NOT NULL
);
CREATE TABLE idempotency_keys (key TEXT PRIMARY KEY, scope TEXT NOT NULL, response TEXT, created_at TEXT NOT NULL);
CREATE TABLE system_clock (id INTEGER PRIMARY KEY CHECK (id = 1), offset_minutes INTEGER NOT NULL DEFAULT 0);
