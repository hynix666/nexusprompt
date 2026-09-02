# Technical Specification: Database Storage Adapter

> **Status**: Draft - September 2026  
> **Version**: 1.0.0  
> **Owner**: Adapter Team  
> **Phase**: Phase 2 (Weeks 11-12)  
> **Effort**: 60-70 hours  
> **Priority**: P0  
> **Related**: [IMPROVEMENT_2026_REVISED.md](../../IMPROVEMENT_2026_REVISED.md)

---

## 📊 Overview

This document specifies the `storage-db` adapter for NexusPrompt, providing persistent storage using PostgreSQL with support for revisions, content, and metadata.

**Key Features:**
- PostgreSQL-based persistent storage
- Multi-tenant support with tenant isolation
- Transaction support for atomic operations
- Migration system for schema evolution
- Query optimization for common patterns
- Connection pooling for performance

---

## 🎯 Requirements

### Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Implement `RevisionStore` interface | P0 | From contracts |
| FR-002 | Support PostgreSQL as storage backend | P0 | Primary database |
| FR-003 | Implement multi-tenant data isolation | P0 | Tenant separation |
| FR-004 | Support transactions for atomic operations | P0 | Data consistency |
| FR-005 | Implement migration system | P0 | Schema evolution |
| FR-006 | Support connection pooling | P0 | Performance |
| FR-007 | Implement query builder or ORM | P1 | Type safety |
| FR-008 | Support pagination for list operations | P1 | Scalability |
| FR-009 | Implement caching layer | P2 | Performance |
| FR-010 | Support backup and restore | P2 | Disaster recovery |

### Non-Functional Requirements

| ID | Requirement | Target | Notes |
|----|-------------|--------|-------|
| NFR-001 | Read latency | < 10ms p95 | For single record |
| NFR-002 | Write latency | < 20ms p95 | For single record |
| NFR-003 | Throughput | 1000 req/sec | Per adapter instance |
| NFR-004 | Memory usage | < 200MB | Connection pool + cache |
| NFR-005 | Availability | 99.99% | With connection retry |
| NFR-006 | Data durability | 99.9999% | PostgreSQL durability |

---

## 🏗️ Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      Database Storage Adapter                    │
├─────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    │
│  │   Revision    │    │   Content     │    │   Metadata    │    │
│  │   Store       │    │   Store      │    │   Store      │    │
│  └──────────────┘    └──────────────┘    └──────────────┘    │
│           ▲                  ▲                  ▲              │
│           │                  │                  │              │
│  ┌────────┴────────┐  ┌─────┴─────┐    ┌─────┴─────┐        │
│  │   SQL Query     │  │  Migration   │    │ Transaction  │        │
│  │   Builder/ORM    │  │   System    │    │   Manager    │        │
│  └─────────────────┘  └─────────────┘    └─────────────┘        │
│           ▲                  ▲                  ▲              │
│           │                  │                  │              │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                    Connection Pool                         │  │
│  └─────────────────────────────────────────────────────────┘  │
│                              ▲                                  │
│                              │                                  │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                    PostgreSQL                              │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────┘
```

### Interface Contract

The adapter **must** implement the `RevisionStore` interface from `contracts/index.ts`:

```typescript
export interface RevisionStore {
  readonly retention_scope: RetentionScope;
  
  // Revision operations
  put(rev: Revision): Promise<void>;
  get(run_id: string, revision_id: UUID): Promise<Revision | null>;
  list(run_id: string, options?: { since?: Timestamp; limit?: number }): Promise<Revision[]>;
  
  // Run operations
  getRun(run_id: string): Promise<Run | null>;
  putRun(run: Run): Promise<void>;
  listRuns(options?: { tenant_id?: string; since?: Timestamp; limit?: number }): Promise<Run[]>;
  
  // Content operations
  putContent(ref: string, bytes: Uint8Array): Promise<void>;
  getContent(ref: string): Promise<Uint8Array | null>;
  hasContent(ref: string): Promise<boolean>;
  listContent(options?: { since?: Timestamp; limit?: number }): Promise<{ ref: string; size: number; timestamp: Timestamp }[]>;
  
  // Cleanup
  sweep(live: Set<string>): Promise<number>;
}
```

---

## 📐 Database Schema

### Type Definitions

```sql
-- Retention scope for content
CREATE TYPE retention_scope AS ENUM ('LOCAL_BUNDLE', 'DB', 'EXPORT');

-- Revision status
CREATE TYPE revision_status AS ENUM ('SUCCEEDED', 'DEMO', 'FAILED', 'CANCELLED', 'SKIPPED');

-- Freshness state
CREATE TYPE freshness AS ENUM ('FRESH', 'STALE');

-- Content kind
CREATE TYPE content_kind AS ENUM ('stage-input', 'stage-output', 'generation-response');
```

### Core Tables

#### Tenants

```sql
CREATE TABLE tenants (
  tenant_id VARCHAR(64) PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Metadata
  name VARCHAR(255),
  description TEXT,
  
  -- Quotas
  max_runs INTEGER DEFAULT NULL,
  max_revisions_per_run INTEGER DEFAULT NULL,
  max_storage_bytes BIGINT DEFAULT NULL,
  
  -- State
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  
  CONSTRAINT valid_tenant_id CHECK (tenant_id ~ '^[a-zA-Z0-9_-]{1,64}$')
);

CREATE INDEX idx_tenants_created_at ON tenants(created_at);
CREATE INDEX idx_tenants_is_active ON tenants(is_active) WHERE is_active = TRUE;
```

#### Runs

```sql
CREATE TABLE runs (
  run_id VARCHAR(64) NOT NULL,
  tenant_id VARCHAR(64) NOT NULL,
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Configuration
  config JSONB NOT NULL,
  config_fingerprint VARCHAR(64),
  
  -- Metadata
  name VARCHAR(255),
  description TEXT,
  tags VARCHAR(255)[],
  
  -- State
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  
  PRIMARY KEY (run_id, tenant_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE CASCADE
);

CREATE INDEX idx_runs_run_id ON runs(run_id);
CREATE INDEX idx_runs_tenant_id ON runs(tenant_id);
CREATE INDEX idx_runs_created_at ON runs(created_at);
CREATE INDEX idx_runs_status ON runs(status);
CREATE INDEX idx_runs_config_fingerprint ON runs(config_fingerprint);
```

#### Revisions

```sql
CREATE TABLE revisions (
  revision_id UUID PRIMARY KEY,
  run_id VARCHAR(64) NOT NULL,
  tenant_id VARCHAR(64) NOT NULL,
  
  -- Stage information
  stage_id VARCHAR(32) NOT NULL,
  parent_revision_ids UUID[] NOT NULL DEFAULT '{}',
  
  -- Timestamps
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Attempt tracking
  stage_attempt INTEGER NOT NULL DEFAULT 1,
  
  -- Content hashes
  input_hash CHAR(64) NOT NULL,
  output_hash CHAR(64) NOT NULL,
  
  -- Gate results
  gate_results JSONB NOT NULL,
  
  -- Feedback
  feedback_round INTEGER,
  
  -- Freshness
  freshness freshness NOT NULL DEFAULT 'FRESH',
  
  -- Status
  status revision_status NOT NULL,
  
  -- Provider information
  provider_used VARCHAR(64),
  
  -- Execution provenance
  execution_provenance JSONB NOT NULL,
  
  -- Retention
  retention_scope retention_scope NOT NULL,
  
  -- Content references
  input_ref VARCHAR(128),
  output_ref VARCHAR(128),
  
  FOREIGN KEY (run_id, tenant_id) REFERENCES runs(run_id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE CASCADE
);

CREATE INDEX idx_revisions_run_id ON revisions(run_id);
CREATE INDEX idx_revisions_tenant_id ON revisions(tenant_id);
CREATE INDEX idx_revisions_revision_id ON revisions(revision_id);
CREATE INDEX idx_revisions_stage_id ON revisions(stage_id);
CREATE INDEX idx_revisions_timestamp ON revisions(timestamp);
CREATE INDEX idx_revisions_status ON revisions(status);
CREATE INDEX idx_revisions_freshness ON revisions(freshness);
CREATE INDEX idx_revisions_parent_ids ON revisions USING GIN(parent_revision_ids);
```

#### Content

```sql
CREATE TABLE content (
  ref VARCHAR(128) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  
  -- Content data (stored as bytes)
  bytes BYTEA NOT NULL,
  
  -- Metadata
  size INTEGER NOT NULL,
  content_type VARCHAR(255),
  kind content_kind NOT NULL,
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Retention
  retention_scope retention_scope NOT NULL,
  
  -- Deduplication
  hash CHAR(64) NOT NULL,
  
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_content_hash ON content(hash) WHERE retention_scope = 'DB';
CREATE INDEX idx_content_tenant_id ON content(tenant_id);
CREATE INDEX idx_content_created_at ON content(created_at);
CREATE INDEX idx_content_accessed_at ON content(accessed_at);
CREATE INDEX idx_content_kind ON content(kind);
CREATE INDEX idx_content_retention_scope ON content(retention_scope);
```

### Views

#### Runs with Tenant Info

```sql
CREATE VIEW runs_with_tenant AS
SELECT 
  r.run_id,
  r.tenant_id,
  t.name as tenant_name,
  r.created_at,
  r.updated_at,
  r.config,
  r.config_fingerprint,
  r.name as run_name,
  r.description as run_description,
  r.tags as run_tags,
  r.status as run_status
FROM runs r
JOIN tenants t ON r.tenant_id = t.tenant_id;
```

#### Revisions with Run Info

```sql
CREATE VIEW revisions_with_run_info AS
SELECT 
  rev.revision_id,
  rev.run_id,
  rev.tenant_id,
  r.name as run_name,
  t.name as tenant_name,
  rev.stage_id,
  rev.parent_revision_ids,
  rev.timestamp,
  rev.stage_attempt,
  rev.input_hash,
  rev.output_hash,
  rev.gate_results,
  rev.feedback_round,
  rev.freshness,
  rev.status,
  rev.provider_used,
  rev.execution_provenance,
  rev.retention_scope,
  rev.input_ref,
  rev.output_ref
FROM revisions rev
JOIN runs r ON rev.run_id = r.run_id AND rev.tenant_id = r.tenant_id
JOIN tenants t ON rev.tenant_id = t.tenant_id;
```

---

## 🔧 Implementation

### Directory Structure

```
adapters/storage-db/
├── src/
│   ├── index.ts                    # Main adapter export
│   ├── database.ts                 # Database connection management
│   ├── migrations/                 # Database migrations
│   │   ├── 001_initial_schema.sql   # Initial schema
│   │   ├── 002_add_indexes.sql      # Additional indexes
│   │   └── ...
│   ├── models/
│   │   ├── tenant.ts               # Tenant model
│   │   ├── run.ts                   # Run model
│   │   ├── revision.ts              # Revision model
│   │   └── content.ts               # Content model
│   ├── repositories/
│   │   ├── revision-repository.ts  # Revision operations
│   │   ├── run-repository.ts        # Run operations
│   │   └── content-repository.ts    # Content operations
│   ├── services/
│   │   ├── transaction.ts           # Transaction management
│   │   └── query-builder.ts         # Query building
│   ├── utils/
│   │   ├── validation.ts            # Input validation
│   │   └── serialization.ts         # Data serialization
│   └── types.ts                    # Type definitions
├── test/
│   ├── database.test.ts            # Database connection tests
│   ├── migrations.test.ts          # Migration tests
│   ├── models/
│   │   ├── tenant.test.ts          # Tenant model tests
│   │   ├── run.test.ts              # Run model tests
│   │   ├── revision.test.ts         # Revision model tests
│   │   └── content.test.ts          # Content model tests
│   ├── repositories/
│   │   ├── revision-repository.test.ts
│   │   ├── run-repository.test.ts
│   │   └── content-repository.test.ts
│   └── integration.test.ts          # Integration tests
├── migrations/
│   └── generated/                   # Generated migration files
├── package.json
├── tsconfig.json
└── README.md
```

### Database Connection Management

```typescript
// adapters/storage-db/src/database.ts

import pg from 'pg';
import { Pool, PoolClient, PoolConfig } from 'pg';

interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  
  // Connection pool settings
  pool?: {
    max?: number;          // Maximum number of clients in the pool
    min?: number;          // Minimum number of clients in the pool
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
  };
  
  // SSL settings
  ssl?: boolean | {
    rejectUnauthorized?: boolean;
    ca?: string;
    cert?: string;
    key?: string;
  };
}

class Database {
  private pool: Pool;
  private config: DatabaseConfig;

  constructor(config: Partial<DatabaseConfig> = {}) {
    this.config = this.mergeConfig(config);
    this.pool = this.createPool();
    
    // Set up pool error handling
    this.pool.on('error', (err) => {
      console.error('Database pool error:', err);
    });
  }

  private mergeConfig(partial: Partial<DatabaseConfig>): DatabaseConfig {
    return {
      host: partial.host || process.env.DB_HOST || 'localhost',
      port: partial.port || parseInt(process.env.DB_PORT || '5432'),
      database: partial.database || process.env.DB_NAME || 'nexusprompt',
      user: partial.user || process.env.DB_USER || 'postgres',
      password: partial.password || process.env.DB_PASSWORD || '',
      pool: {
        max: partial.pool?.max || 20,
        min: partial.pool?.min || 4,
        idleTimeoutMillis: partial.pool?.idleTimeoutMillis || 30000,
        connectionTimeoutMillis: partial.pool?.connectionTimeoutMillis || 5000,
      },
      ssl: partial.ssl || process.env.DB_SSL === 'true' ? true : false,
    };
  }

  private createPool(): Pool {
    const poolConfig: PoolConfig = {
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
      max: this.config.pool?.max,
      min: this.config.pool?.min,
      idleTimeoutMillis: this.config.pool?.idleTimeoutMillis,
      connectionTimeoutMillis: this.config.pool?.connectionTimeoutMillis,
    };

    // Configure SSL if enabled
    if (this.config.ssl) {
      poolConfig.ssl = typeof this.config.ssl === 'boolean' 
        ? { rejectUnauthorized: !this.config.ssl }
        : this.config.ssl;
    }

    return new Pool(poolConfig);
  }

  async getClient(): Promise<PoolClient> {
    const client = await this.pool.connect();
    
    // Set up client error handling
    client.on('error', (err) => {
      console.error('Database client error:', err);
    });
    
    return client;
  }

  async query<T = any>(text: string, params?: any[]): Promise<pg.QueryResult<T>> {
    const start = Date.now();
    try {
      const result = await this.pool.query(text, params);
      const duration = Date.now() - start;
      
      // Log slow queries
      if (duration > 100) {
        console.warn(`Slow query (${duration}ms):`, text);
      }
      
      return result;
    } catch (error) {
      console.error('Database query error:', error);
      throw error;
    }
  }

  async getSingle<T = any>(text: string, params?: any[]): Promise<T | null> {
    const result = await this.query<T>(text, params);
    return result.rows[0] || null;
  }

  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.getClient();
    
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.query('SELECT 1');
      return result.rowCount === 1;
    } catch (error) {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  getPool(): Pool {
    return this.pool;
  }

  static async createTables(pool: Pool): Promise<void> {
    // This would be replaced by the migration system
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Create types
      await client.query(`
        CREATE TYPE IF NOT EXISTS retention_scope AS ENUM ('LOCAL_BUNDLE', 'DB', 'EXPORT')
      `);
      await client.query(`
        CREATE TYPE IF NOT EXISTS revision_status AS ENUM ('SUCCEEDED', 'DEMO', 'FAILED', 'CANCELLED', 'SKIPPED')
      `);
      await client.query(`
        CREATE TYPE IF NOT EXISTS freshness AS ENUM ('FRESH', 'STALE')
      `);
      await client.query(`
        CREATE TYPE IF NOT EXISTS content_kind AS ENUM ('stage-input', 'stage-output', 'generation-response')
      `);
      
      // Create tables (simplified - see full schema above)
      // ...
      
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export { Database, DatabaseConfig };
```

### Migration System

```typescript
// adapters/storage-db/src/migrations/migrator.ts

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

interface Migration {
  id: string;
  name: string;
  filename: string;
  content: string;
  checksum: string;
}

class Migrator {
  private pool: Pool;
  private migrationsDir: string;

  constructor(pool: Pool, migrationsDir: string = 'migrations') {
    this.pool = pool;
    this.migrationsDir = migrationsDir;
  }

  async migrate(): Promise<{ applied: string[]; skipped: string[] }> {
    const applied: string[] = [];
    const skipped: string[] = [];
    
    // Create migrations table if it doesn't exist
    await this.ensureMigrationsTable();
    
    // Get already applied migrations
    const appliedMigrations = await this.getAppliedMigrations();
    
    // Get all available migrations
    const availableMigrations = this.getAvailableMigrations();
    
    // Sort migrations by filename (lexicographic order)
    availableMigrations.sort((a, b) => a.filename.localeCompare(b.filename));
    
    // Apply migrations in order
    for (const migration of availableMigrations) {
      if (appliedMigrations.has(migration.id)) {
        skipped.push(migration.id);
        continue;
      }
      
      await this.applyMigration(migration);
      applied.push(migration.id);
    }
    
    return { applied, skipped };
  }

  private async ensureMigrationsTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        filename VARCHAR(255) NOT NULL,
        checksum VARCHAR(64) NOT NULL,
        executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  private async getAppliedMigrations(): Promise<Set<string>> {
    const result = await this.pool.query<{ id: string }>(
      'SELECT id FROM schema_migrations'
    );
    return new Set(result.rows.map(row => row.id));
  }

  private getAvailableMigrations(): Migration[] {
    const files = readdirSync(this.migrationsDir).filter(f => f.endsWith('.sql'));
    
    return files.map(filename => {
      const content = readFileSync(join(this.migrationsDir, filename), 'utf8');
      const id = filename.replace('.sql', '');
      const name = filename;
      const checksum = this.calculateChecksum(content);
      
      return { id, name, filename, content, checksum };
    });
  }

  private calculateChecksum(content: string): string {
    // Simple checksum for demonstration
    // In production, use SHA-256
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  private async applyMigration(migration: Migration): Promise<void> {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Execute migration
      await client.query(migration.content);
      
      // Record migration
      await client.query(
        'INSERT INTO schema_migrations (id, name, filename, checksum) VALUES ($1, $2, $3, $4)',
        [migration.id, migration.name, migration.filename, migration.checksum]
      );
      
      await client.query('COMMIT');
      
      console.log(`Applied migration: ${migration.id}`);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`Failed to apply migration ${migration.id}:`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  async rollback(migrationId: string): Promise<void> {
    // Rollback logic would be implemented here
    // For now, migrations are not designed to be rolled back
    throw new Error('Rollback not supported');
  }

  async status(): Promise<{ applied: string[]; pending: string[] }> {
    const appliedMigrations = await this.getAppliedMigrations();
    const availableMigrations = this.getAvailableMigrations();
    
    const applied: string[] = [];
    const pending: string[] = [];
    
    for (const migration of availableMigrations) {
      if (appliedMigrations.has(migration.id)) {
        applied.push(migration.id);
      } else {
        pending.push(migration.id);
      }
    }
    
    return { applied, pending };
  }
}

export { Migrator };
```

### Main Adapter Implementation

```typescript
// adapters/storage-db/src/index.ts

import type {
  Revision,
  Run,
  UUID,
  Timestamp,
  RetentionScope,
  RevisionStore,
} from "../../../contracts/index.js";

import { Database } from "./database.js";
import { Migrator } from "./migrations/migrator.js";
import { RevisionRepository } from "./repositories/revision-repository.js";
import { RunRepository } from "./repositories/run-repository.js";
import { ContentRepository } from "./repositories/content-repository.js";
import type { DatabaseConfig } from "./database.js";

export interface DBStorageOptions {
  database: Partial<DatabaseConfig>;
  autoMigrate?: boolean;
  tenantId?: string;  // Default tenant for single-tenant mode
}

export class DBStorageAdapter implements RevisionStore {
  readonly retention_scope: RetentionScope = 'DB';
  
  private database: Database;
  private revisionRepo: RevisionRepository;
  private runRepo: RunRepository;
  private contentRepo: ContentRepository;
  private tenantId: string;

  constructor(options: DBStorageOptions) {
    this.tenantId = options.tenantId || 'default';
    this.database = new Database(options.database);
    this.revisionRepo = new RevisionRepository(this.database);
    this.runRepo = new RunRepository(this.database);
    this.contentRepo = new ContentRepository(this.database);
  }

  async initialize(): Promise<void> {
    // Run migrations if auto-migrate is enabled
    if (this.options.autoMigrate !== false) {
      const migrator = new Migrator(this.database.getPool());
      await migrator.migrate();
    }
    
    // Verify database connection
    const healthy = await this.database.healthCheck();
    if (!healthy) {
      throw new Error('Database connection failed');
    }
  }

  // RevisionStore interface implementation

  async put(rev: Revision): Promise<void> {
    await this.revisionRepo.put(rev, this.tenantId);
  }

  async get(run_id: string, revision_id: UUID): Promise<Revision | null> {
    return this.revisionRepo.get(run_id, revision_id, this.tenantId);
  }

  async list(
    run_id: string,
    options?: { since?: Timestamp; limit?: number }
  ): Promise<Revision[]> {
    return this.revisionRepo.list(run_id, this.tenantId, options);
  }

  async getRun(run_id: string): Promise<Run | null> {
    return this.runRepo.get(run_id, this.tenantId);
  }

  async putRun(run: Run): Promise<void> {
    await this.runRepo.put(run, this.tenantId);
  }

  async listRuns(options?: { tenant_id?: string; since?: Timestamp; limit?: number }): Promise<Run[]> {
    const tenantId = options?.tenant_id || this.tenantId;
    return this.runRepo.list(tenantId, options);
  }

  async putContent(ref: string, bytes: Uint8Array): Promise<void> {
    await this.contentRepo.put(ref, bytes, this.tenantId);
  }

  async getContent(ref: string): Promise<Uint8Array | null> {
    return this.contentRepo.get(ref, this.tenantId);
  }

  async hasContent(ref: string): Promise<boolean> {
    return this.contentRepo.has(ref, this.tenantId);
  }

  async listContent(options?: { since?: Timestamp; limit?: number }): Promise<{ ref: string; size: number; timestamp: Timestamp }[]> {
    return this.contentRepo.list(this.tenantId, options);
  }

  async sweep(live: Set<string>): Promise<number> {
    return this.contentRepo.sweep(live, this.tenantId);
  }

  // Additional methods

  async close(): Promise<void> {
    await this.database.close();
  }

  async healthCheck(): Promise<boolean> {
    return this.database.healthCheck();
  }
}

export { DBStorageOptions, DatabaseConfig };
export default DBStorageAdapter;
```

---

## 🧪 Testing Strategy

### Unit Tests

| Component | Tests | Coverage Target |
|-----------|-------|-----------------|
| Database Connection | 10 | 95% |
| Migration System | 15 | 95% |
| Tenant Model | 10 | 90% |
| Run Model | 10 | 90% |
| Revision Model | 15 | 90% |
| Content Model | 10 | 90% |
| Revision Repository | 20 | 95% |
| Run Repository | 15 | 95% |
| Content Repository | 20 | 95% |
| Main Adapter | 25 | 90% |
| **Total** | **140** | **92%** |

### Integration Tests

| Scenario | Tests |
|----------|-------|
| End-to-end CRUD operations | 10 |
| Transaction rollback | 5 |
| Connection pooling | 5 |
| Multi-tenant isolation | 5 |
| Migration system | 5 |
| Error handling | 5 |
| **Total** | **35** |

### Test Example

```typescript
// test/repositories/revision-repository.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Pool } from 'pg';
import { Database } from '../../src/database.js';
import { RevisionRepository } from '../../src/repositories/revision-repository.js';
import type { Revision, UUID } from '../../../../contracts/index.js';

describe('RevisionRepository', () => {
  let pool: Pool;
  let database: Database;
  let repo: RevisionRepository;

  beforeEach(async () => {
    pool = new Pool({
      host: 'localhost',
      port: 5432,
      database: 'nexusprompt_test',
      user: 'postgres',
      password: 'password',
    });
    
    database = new Database();
    repo = new RevisionRepository(database);
    
    // Create test tables
    await database.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        tenant_id VARCHAR(64) PRIMARY KEY
      )
    `);
    await database.query(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id VARCHAR(64) NOT NULL,
        tenant_id VARCHAR(64) NOT NULL,
        PRIMARY KEY (run_id, tenant_id),
        FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)
      )
    `);
    await database.query(`
      CREATE TABLE IF NOT EXISTS revisions (
        revision_id UUID PRIMARY KEY,
        run_id VARCHAR(64) NOT NULL,
        tenant_id VARCHAR(64) NOT NULL,
        stage_id VARCHAR(32) NOT NULL,
        FOREIGN KEY (run_id, tenant_id) REFERENCES runs(run_id, tenant_id)
      )
    `);
    
    // Insert test tenant
    await database.query('INSERT INTO tenants (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING', ['test-tenant']);
    
    // Insert test run
    await database.query(
      'INSERT INTO runs (run_id, tenant_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      ['test-run-1', 'test-tenant']
    );
  });

  afterEach(async () => {
    // Clean up test data
    await database.query('DELETE FROM revisions WHERE tenant_id = $1', ['test-tenant']);
    await database.query('DELETE FROM runs WHERE tenant_id = $1', ['test-tenant']);
    await pool.end();
  });

  describe('put and get', () => {
    it('should put and get a revision', async () => {
      const revision: Revision = {
        revision_id: '123e4567-e89b-12d3-a456-426614174000' as UUID,
        run_id: 'test-run-1',
        stage_id: 'compile',
        parent_revision_ids: [],
        timestamp: new Date().toISOString() as Timestamp,
        stage_attempt: 1,
        input_hash: 'a'.repeat(64) as any,
        output_hash: 'b'.repeat(64) as any,
        gate_results: {},
        freshness: 'FRESH',
        status: 'SUCCEEDED',
        provider_used: 'provider-local-proxy',
        execution_provenance: { type: 'local' },
        retention_scope: 'DB',
        input_ref: 'ref-1',
        output_ref: 'ref-2',
      };

      await repo.put(revision, 'test-tenant');
      
      const result = await repo.get('test-run-1', revision.revision_id, 'test-tenant');
      
      expect(result).not.toBeNull();
      expect(result?.revision_id).toBe(revision.revision_id);
      expect(result?.run_id).toBe(revision.run_id);
    });

    it('should return null for non-existent revision', async () => {
      const result = await repo.get(
        'test-run-1',
        '00000000-0000-0000-0000-000000000000' as UUID,
        'test-tenant'
      );
      
      expect(result).toBeNull();
    });
  });

  describe('list', () => {
    it('should list revisions for a run', async () => {
      const revisions: Revision[] = [
        {
          revision_id: '123e4567-e89b-12d3-a456-426614174000' as UUID,
          run_id: 'test-run-1',
          stage_id: 'compile',
          parent_revision_ids: [],
          timestamp: new Date().toISOString() as Timestamp,
          stage_attempt: 1,
          input_hash: 'a'.repeat(64) as any,
          output_hash: 'b'.repeat(64) as any,
          gate_results: {},
          freshness: 'FRESH',
          status: 'SUCCEEDED',
          provider_used: 'provider-local-proxy',
          execution_provenance: { type: 'local' },
          retention_scope: 'DB',
          input_ref: 'ref-1',
          output_ref: 'ref-2',
        },
        {
          revision_id: '123e4567-e89b-12d3-a456-426614174001' as UUID,
          run_id: 'test-run-1',
          stage_id: 'deconstruct',
          parent_revision_ids: [],
          timestamp: new Date().toISOString() as Timestamp,
          stage_attempt: 1,
          input_hash: 'c'.repeat(64) as any,
          output_hash: 'd'.repeat(64) as any,
          gate_results: {},
          freshness: 'FRESH',
          status: 'SUCCEEDED',
          provider_used: 'provider-local-proxy',
          execution_provenance: { type: 'local' },
          retention_scope: 'DB',
          input_ref: 'ref-3',
          output_ref: 'ref-4',
        },
      ];

      for (const rev of revisions) {
        await repo.put(rev, 'test-tenant');
      }

      const result = await repo.list('test-run-1', 'test-tenant');
      
      expect(result).toHaveLength(2);
      expect(result.map(r => r.revision_id)).toContain(revisions[0].revision_id);
      expect(result.map(r => r.revision_id)).toContain(revisions[1].revision_id);
    });
  });
});
```

---

## 📊 Performance Considerations

### Connection Pooling

The adapter uses `pg` library's built-in connection pooling:
- **Max connections**: 20 (configurable)
- **Min connections**: 4 (configurable)
- **Idle timeout**: 30 seconds (configurable)
- **Connection timeout**: 5 seconds (configurable)

### Caching

The adapter implements caching for:
- **Content**: LRU cache with 1000 item limit
- **Runs**: LRU cache with 500 item limit
- **Schema**: Unlimited cache for schema information

### Query Optimization

**Indexes**: All frequently queried columns have indexes
**Query Plans**: Complex queries use explicit JOINs and WHERE clauses
**Batch Operations**: Bulk inserts for initial data loading

---

## 🔒 Security Considerations

### SQL Injection Prevention
- All queries use parameterized queries
- No string concatenation for SQL
- Input validation for all user-provided values

### Data Isolation
- Tenant ID is included in all queries
- Row-level security could be implemented at database level
- No cross-tenant data access

### Authentication
- Database credentials are never logged
- Credentials are stored securely
- Connection strings are validated

---

## 📝 Monitoring and Observability

### Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `db.queries.total` | Counter | Total queries executed |
| `db.queries.duration` | Histogram | Query duration in ms |
| `db.queries.errors` | Counter | Query errors |
| `db.connections.total` | Gauge | Current connection count |
| `db.connections.idle` | Gauge | Idle connection count |
| `db.pool.wait_time` | Histogram | Time waiting for connection |
| `db.transactions.total` | Counter | Total transactions |
| `db.transactions.duration` | Histogram | Transaction duration |

### Logging

| Level | Usage |
|-------|-------|
| DEBUG | Detailed query logging |
| INFO | High-level operations |
| WARN | Slow queries, connection issues |
| ERROR | Query failures, connection errors |

**Log Format:**
```json
{
  "timestamp": "2026-09-01T10:00:00.000Z",
  "level": "INFO",
  "message": "Query executed",
  "query": "SELECT * FROM revisions WHERE run_id = $1",
  "params": ["test-run-1"],
  "duration": 15,
  "rows": 10,
  "tenantId": "test-tenant"
}
```

### Health Check

The health check verifies:
- Database connection is alive
- Connection pool has available connections
- Recent query success rate
- Migration status

---

## 🚀 Deployment

### Configuration

```bash
# Environment variables
export DB_HOST='localhost'
export DB_PORT='5432'
export DB_NAME='nexusprompt'
export DB_USER='postgres'
export DB_PASSWORD='password'
export DB_POOL_MAX='20'
export DB_POOL_MIN='4'
export DB_SSL='false'
export DB_AUTO_MIGRATE='true'
```

### Docker

```dockerfile
FROM node:24-alpine

WORKDIR /app

# Install PostgreSQL client
RUN apk add --no-cache postgresql-client

COPY package*.json ./
RUN npm install --production

COPY . .

# Wait for database to be ready
CMD ["sh", "-c", "while ! pg_isready -h $DB_HOST -p $DB_PORT -U $DB_USER; do sleep 1; done && node dist/adapters/storage-db/src/index.js"]
```

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: storage-db-adapter
spec:
  replicas: 2
  selector:
    matchLabels:
      app: storage-db-adapter
  template:
    metadata:
      labels:
        app: storage-db-adapter
    spec:
      containers:
      - name: adapter
        image: nexusprompt/storage-db-adapter:v1.0.0
        env:
        - name: DB_HOST
          value: "postgres-service"
        - name: DB_PORT
          value: "5432"
        - name: DB_NAME
          value: "nexusprompt"
        - name: DB_USER
          valueFrom:
            secretKeyRef:
              name: db-secrets
              key: username
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: db-secrets
              key: password
        - name: DB_SSL
          value: "true"
        - name: DB_POOL_MAX
          value: "30"
        resources:
          limits:
            memory: "512Mi"
            cpu: "1"
          requests:
            memory: "256Mi"
            cpu: "500m"
        livenessProbe:
          exec:
            command: ["sh", "-c", "pg_isready -h $DB_HOST -p $DB_PORT -U $DB_USER"]
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 5
---
```

---

## 📝 Specification Metadata

| Field | Value |
|-------|-------|
| **Version** | 1.0.0 |
| **Last Updated** | September 2026 |
| **Owner** | Adapter Team |
| **Phase** | Phase 2 (Weeks 11-12) |
| **Effort** | 60-70 hours |
| **Priority** | P0 |
| **Status** | Draft |
| **Repository** | hynix666/nexusprompt |
| **Related Documents** | [IMPROVEMENT_2026_REVISED.md](../../IMPROVEMENT_2026_REVISED.md) |

---

## 🔗 References

- [RevisionStore Interface](../../../contracts/index.ts)
- [Revision Type](../../../contracts/index.ts)
- [Run Type](../../../contracts/index.ts)
- [UUID Type](../../../contracts/index.ts)
- [Timestamp Type](../../../contracts/index.ts)
- [RetentionScope Type](../../../contracts/index.ts)
- [pg (PostgreSQL client)](https://node-postgres.com/)
- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
- [Connection Pooling](https://node-postgres.com/apis/pool)
