/**
 * Database schema. Append new migrations — never edit an applied one.
 */
const T = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

export const MIGRATIONS: { version: number; name: string; statements: string[] }[] = [
  {
    version: 1,
    name: 'initial schema',
    statements: [
      `CREATE TABLE users (
         id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
         email VARCHAR(255) NOT NULL,
         username VARCHAR(64) NOT NULL,
         display_name VARCHAR(128) NOT NULL,
         password_hash VARCHAR(255) NOT NULL,
         role ENUM('admin','user') NOT NULL DEFAULT 'user',
         status ENUM('active','disabled') NOT NULL DEFAULT 'active',
         created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
         last_login_at DATETIME(3) NULL,
         UNIQUE KEY uq_users_email (email),
         UNIQUE KEY uq_users_username (username)
       ) ${T}`,

      `CREATE TABLE sessions (
         id CHAR(64) PRIMARY KEY,
         user_id INT UNSIGNED NOT NULL,
         created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
         expires_at DATETIME(3) NOT NULL,
         last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
         ip VARCHAR(64) NULL,
         user_agent VARCHAR(255) NULL,
         KEY ix_sessions_user (user_id),
         CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
       ) ${T}`,

      `CREATE TABLE settings (
         k VARCHAR(64) PRIMARY KEY,
         v JSON NOT NULL
       ) ${T}`,

      `CREATE TABLE claude_connections (
         user_id INT UNSIGNED PRIMARY KEY,
         method ENUM('login','oauth_token','api_key') NOT NULL DEFAULT 'login',
         secret_enc TEXT NULL,
         secret_hint VARCHAR(32) NULL,
         default_model VARCHAR(64) NULL,
         last_status JSON NULL,
         verified_at DATETIME(3) NULL,
         updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
         CONSTRAINT fk_claude_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
       ) ${T}`,

      `CREATE TABLE projects (
         id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
         owner_id INT UNSIGNED NOT NULL,
         name VARCHAR(128) NOT NULL,
         area VARCHAR(32) NOT NULL,
         description TEXT NULL,
         settings JSON NULL,
         created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
         updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
         last_opened_at DATETIME(3) NULL,
         KEY ix_projects_owner (owner_id, area),
         CONSTRAINT fk_projects_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
       ) ${T}`,

      `CREATE TABLE chats (
         id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
         project_id INT UNSIGNED NOT NULL,
         title VARCHAR(255) NOT NULL,
         claude_session_id CHAR(36) NOT NULL,
         started TINYINT(1) NOT NULL DEFAULT 0,
         total_cost_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
         created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
         updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
         KEY ix_chats_project (project_id),
         CONSTRAINT fk_chats_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
       ) ${T}`,

      `CREATE TABLE chat_events (
         id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
         chat_id INT UNSIGNED NOT NULL,
         kind VARCHAR(32) NOT NULL,
         payload JSON NOT NULL,
         created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
         KEY ix_events_chat (chat_id, id),
         CONSTRAINT fk_events_chat FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
       ) ${T}`,

      `CREATE TABLE assets (
         id VARCHAR(24) PRIMARY KEY,
         owner_id INT UNSIGNED NOT NULL,
         name VARCHAR(160) NOT NULL,
         kind VARCHAR(32) NOT NULL,
         area VARCHAR(32) NULL,
         description TEXT NULL,
         tags VARCHAR(512) NOT NULL DEFAULT '',
         visibility ENUM('private','global') NOT NULL DEFAULT 'private',
         main_file VARCHAR(512) NULL,
         files JSON NOT NULL,
         size_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
         has_thumb TINYINT(1) NOT NULL DEFAULT 0,
         source_project_id INT UNSIGNED NULL,
         license VARCHAR(64) NULL,
         import_count INT UNSIGNED NOT NULL DEFAULT 0,
         created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
         updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
         published_at DATETIME(3) NULL,
         KEY ix_assets_owner (owner_id, created_at),
         KEY ix_assets_visibility (visibility, published_at),
         CONSTRAINT fk_assets_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
       ) ${T}`,
    ],
  },
  {
    version: 2,
    name: 'usage log, plan limits, account extras',
    statements: [
      // one row per finished Claude run (chat message) — what the Usage page sums up
      `CREATE TABLE usage_runs (
         id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
         user_id INT UNSIGNED NOT NULL,
         project_id INT UNSIGNED NULL,
         chat_id INT UNSIGNED NULL,
         kind VARCHAR(16) NOT NULL DEFAULT 'chat',
         model VARCHAR(64) NULL,
         status VARCHAR(16) NOT NULL DEFAULT 'ok',
         turns INT UNSIGNED NOT NULL DEFAULT 0,
         duration_ms INT UNSIGNED NOT NULL DEFAULT 0,
         input_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
         output_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
         cache_read_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
         cache_write_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
         cost_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
         source_event_id BIGINT UNSIGNED NULL,
         created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
         KEY ix_usage_user (user_id, created_at),
         UNIQUE KEY uq_usage_event (source_event_id),
         CONSTRAINT fk_usage_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
       ) ${T}`,
      // latest subscription rate-limit status Claude Code reported (5-hour / weekly windows)
      `ALTER TABLE claude_connections ADD COLUMN rate_limit JSON NULL, ADD COLUMN rate_limit_at DATETIME(3) NULL`,
      // 1 = load the account's own plugins, claude.ai connectors and MCP servers in Studio runs
      `ALTER TABLE claude_connections ADD COLUMN account_extras TINYINT(1) NOT NULL DEFAULT 0`,
    ],
  },
  {
    version: 3,
    name: 'no stored subscription tokens',
    statements: [
      // Third-party software must not collect or store Claude subscription credentials/tokens
      // (Anthropic's rules for platforms hosting Claude Code). Earlier versions stored pasted
      // `claude setup-token` tokens — delete them; those users sign in to Claude Code instead.
      `UPDATE claude_connections SET method = 'login', secret_enc = NULL, secret_hint = NULL, verified_at = NULL WHERE method = 'oauth_token'`,
    ],
  },
  {
    version: 4,
    name: 'services (deployed Node.js servers)',
    statements: [
      `CREATE TABLE services (
         id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
         owner_id INT UNSIGNED NOT NULL,
         project_id INT UNSIGNED NOT NULL,
         name VARCHAR(64) NOT NULL,
         slug VARCHAR(64) NOT NULL,
         root VARCHAR(255) NOT NULL DEFAULT 'server',
         desired ENUM('running','stopped') NOT NULL DEFAULT 'stopped',
         release_no INT UNSIGNED NOT NULL DEFAULT 0,
         settings JSON NULL,
         env_enc TEXT NULL,
         created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
         updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
         deployed_at DATETIME(3) NULL,
         UNIQUE KEY uq_services_slug (slug),
         UNIQUE KEY uq_services_root (project_id, root),
         KEY ix_services_owner (owner_id),
         CONSTRAINT fk_services_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
         CONSTRAINT fk_services_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
       ) ${T}`,
    ],
  },
  {
    version: 5,
    name: 'sites (published websites + their domains)',
    statements: [
      `CREATE TABLE sites (
         id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
         owner_id INT UNSIGNED NOT NULL,
         project_id INT UNSIGNED NOT NULL,
         slug VARCHAR(63) NOT NULL,
         enabled TINYINT(1) NOT NULL DEFAULT 1,
         release_no INT UNSIGNED NOT NULL DEFAULT 0,
         settings JSON NULL,
         stats JSON NULL,
         publish_log MEDIUMTEXT NULL,
         created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
         updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
         published_at DATETIME(3) NULL,
         UNIQUE KEY uq_sites_slug (slug),
         UNIQUE KEY uq_sites_project (project_id),
         KEY ix_sites_owner (owner_id),
         CONSTRAINT fk_sites_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
         CONSTRAINT fk_sites_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
       ) ${T}`,
      `CREATE TABLE site_domains (
         domain VARCHAR(253) NOT NULL PRIMARY KEY,
         site_id INT UNSIGNED NOT NULL,
         created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
         KEY ix_site_domains_site (site_id),
         CONSTRAINT fk_site_domains_site FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
       ) ${T}`,
    ],
  },
  {
    version: 6,
    name: 'more AI providers (ACP agents): provider per chat, API keys, preferences',
    statements: [
      // which AI runs a chat; ACP agents keep their own session id (Claude Code keeps claude_session_id)
      `ALTER TABLE chats ADD COLUMN provider VARCHAR(48) NOT NULL DEFAULT 'claude', ADD COLUMN agent_session_id VARCHAR(255) NULL`,
      // the users' own API keys for other AI vendors (the Anthropic key stays in claude_connections)
      `CREATE TABLE agent_keys (
         user_id INT UNSIGNED NOT NULL,
         key_id VARCHAR(32) NOT NULL,
         secret_enc TEXT NOT NULL,
         secret_hint VARCHAR(32) NULL,
         updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
         PRIMARY KEY (user_id, key_id),
         CONSTRAINT fk_agent_keys_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
       ) ${T}`,
      // default AI for new chats, default model per AI
      `CREATE TABLE agent_prefs (
         user_id INT UNSIGNED PRIMARY KEY,
         prefs JSON NULL,
         updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
         CONSTRAINT fk_agent_prefs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
       ) ${T}`,
      `ALTER TABLE usage_runs ADD COLUMN provider VARCHAR(48) NOT NULL DEFAULT 'claude'`,
    ],
  },
  {
    version: 7,
    name: 'HTTPS certificates per host, skills, instructions',
    statements: [
      // TLS of one host name (a website domain, <name>.<base domain>, the Studio's own domain, or a
      // wildcard "*.example.com"): how it gets its certificate, the certificate itself, issuing state
      `CREATE TABLE tls_hosts (
         host VARCHAR(253) NOT NULL PRIMARY KEY,
         kind VARCHAR(16) NOT NULL DEFAULT 'site',
         mode VARCHAR(16) NOT NULL DEFAULT 'auto',
         force_https TINYINT(1) NOT NULL DEFAULT 1,
         hsts TINYINT(1) NOT NULL DEFAULT 0,
         source VARCHAR(16) NULL,
         cert_pem MEDIUMTEXT NULL,
         key_enc MEDIUMTEXT NULL,
         issuer VARCHAR(255) NULL,
         names TEXT NULL,
         not_before DATETIME NULL,
         not_after DATETIME NULL,
         status VARCHAR(16) NOT NULL DEFAULT 'none',
         last_error TEXT NULL,
         attempts INT UNSIGNED NOT NULL DEFAULT 0,
         next_try_at DATETIME NULL,
         issued_at DATETIME NULL,
         created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
         updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
       ) ${T}`,
      // skills: reusable know-how (a SKILL.md: when to use it + instructions) the AI loads on demand
      `CREATE TABLE skills (
         id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
         owner_id INT UNSIGNED NOT NULL,
         slug VARCHAR(64) NOT NULL,
         name VARCHAR(128) NOT NULL,
         description VARCHAR(1024) NOT NULL,
         body MEDIUMTEXT NOT NULL,
         areas VARCHAR(255) NOT NULL DEFAULT '',
         auto TINYINT(1) NOT NULL DEFAULT 1,
         visibility ENUM('private','global') NOT NULL DEFAULT 'private',
         reviewed TINYINT(1) NOT NULL DEFAULT 0,
         uses INT UNSIGNED NOT NULL DEFAULT 0,
         created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
         updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
         published_at DATETIME(3) NULL,
         UNIQUE KEY uq_skills_owner_slug (owner_id, slug),
         KEY ix_skills_visibility (visibility),
         CONSTRAINT fk_skills_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
       ) ${T}`,
      // which skills a user switched on or off (key: "sys:<slug>" built-in, "<id>" a stored skill)
      `CREATE TABLE skill_prefs (
         user_id INT UNSIGNED NOT NULL,
         skill_key VARCHAR(96) NOT NULL,
         enabled TINYINT(1) NOT NULL,
         PRIMARY KEY (user_id, skill_key),
         CONSTRAINT fk_skill_prefs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
       ) ${T}`,
      // a user's own standing instructions for the AI: scope "all" or an area id (music, game … chat)
      `CREATE TABLE user_instructions (
         user_id INT UNSIGNED NOT NULL,
         scope VARCHAR(32) NOT NULL,
         body MEDIUMTEXT NOT NULL,
         enabled TINYINT(1) NOT NULL DEFAULT 1,
         updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
         PRIMARY KEY (user_id, scope),
         CONSTRAINT fk_user_instructions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
       ) ${T}`,
    ],
  },
  {
    version: 8,
    name: 'project releases (versioning), WordPress sites',
    statements: [
      // a released version of a project: a git tag plus (optionally) a copy of its exports/
      `CREATE TABLE project_releases (
         id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
         project_id INT UNSIGNED NOT NULL,
         version VARCHAR(64) NOT NULL,
         title VARCHAR(200) NULL,
         notes TEXT NULL,
         sha CHAR(40) NULL,
         tag VARCHAR(80) NULL,
         artifacts JSON NULL,
         created_by VARCHAR(128) NULL,
         created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
         UNIQUE KEY uq_releases_version (project_id, version),
         CONSTRAINT fk_releases_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
       ) ${T}`,
      // a WordPress installation inside a project (wordpress.ts): its own database and PHP process
      `CREATE TABLE wordpress_sites (
         id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
         owner_id INT UNSIGNED NOT NULL,
         project_id INT UNSIGNED NOT NULL,
         state VARCHAR(16) NOT NULL DEFAULT 'new',
         desired ENUM('running','stopped') NOT NULL DEFAULT 'running',
         db_name VARCHAR(64) NULL,
         db_user VARCHAR(64) NULL,
         db_pass_enc TEXT NULL,
         login_secret_enc TEXT NULL,
         settings JSON NULL,
         info JSON NULL,
         last_error TEXT NULL,
         created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
         updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
         installed_at DATETIME(3) NULL,
         UNIQUE KEY uq_wordpress_project (project_id),
         KEY ix_wordpress_owner (owner_id),
         CONSTRAINT fk_wordpress_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
         CONSTRAINT fk_wordpress_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
       ) ${T}`,
    ],
  },
];
