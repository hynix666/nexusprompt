# Technical Specification: Content Deletion Port

> **Status**: Draft - September 2026  
> **Version**: 1.0.0  
> **Owner**: Core Team  
> **Phase**: Phase 2 (Week 19)  
> **Effort**: 20-25 hours  
> **Priority**: P1  
> **Related**: [IMPROVEMENT_2026_REVISED.md](../../IMPROVEMENT_2026_REVISED.md)

---

## 📊 Overview

This document specifies the content deletion capability for NexusPrompt, addressing the current gap in content lifecycle management. The implementation adds deletion semantics to the existing `ContentStore` interface while respecting content deduplication and reference counting.

**Key Features:**
- Reference counting for deduplicated content
- Soft delete and hard delete modes
- Audit logging for all deletion operations
- Cross-tenant isolation
- Safety checks and confirmation requirements

---

## 🎯 Requirements

### Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Implement `delete` method on `ContentStore` | P0 | Core functionality |
| FR-002 | Implement reference counting | P0 | Prevent orphaned content |
| FR-003 | Support soft delete mode | P0 | Mark as deleted, keep data |
| FR-004 | Support hard delete mode | P0 | Permanent removal |
| FR-005 | Implement audit logging | P0 | Track all deletions |
| FR-006 | Support cross-tenant isolation | P0 | Tenant-specific deletion |
| FR-007 | Implement confirmation mechanism | P0 | Prevent accidental deletion |
| FR-008 | Implement sweep operation | P1 | Clean up orphaned content |
| FR-009 | Support retention scope filtering | P1 | Respect retention policies |
| FR-010 | Provide deletion metrics | P2 | Monitoring and observability |

### Non-Functional Requirements

| ID | Requirement | Target | Notes |
|----|-------------|--------|-------|
| NFR-001 | Deletion latency | < 50ms p95 | For soft delete |
| NFR-002 | Sweep latency | < 100ms per 1000 items | Batch processing |
| NFR-003 | Memory overhead | < 10MB | For reference tracking |
| NFR-004 | Data safety | 100% | No accidental data loss |
| NFR-005 | Audit completeness | 100% | All deletions logged |

---

## 🏗️ Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      Content Deletion System                    │
├─────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    │
│  │   Content     │    │  Reference    │    │   Audit      │    │
│  │   Store       │───▶│   Counter     │───▶│   Logger     │    │
│  └──────────────┘    └──────────────┘    └──────────────┘    │
│           ▲                  ▲                  ▲              │
│           │                  │                  │              │
│  ┌────────┴────────┐  ┌─────┴─────┐    ┌─────┴─────┐        │
│  │   Delete        │  │  Sweep       │    │  Confirm    │        │
│  │   Operation     │  │  Operation   │    │  Mechanism   │        │
│  └─────────────────┘  └─────────────┘    └─────────────┘        │
│                                                                  │
└─────────────────────────────────────────────────────────────┘
```

### Content Addressing and Deduplication

NexusPrompt uses **content-addressable storage** with deduplication:

1. **Content Hash**: Each unique content is identified by its SHA-256 hash
2. **Reference**: Content is referenced by a logical reference (ref)
3. **Deduplication**: Multiple refs can point to the same content hash
4. **Storage**: Content is stored once, regardless of how many refs point to it

```
┌─────────────────────────────────────────────────────────────┐
│                        Storage Layout                            │
├─────────────────────────────────────────────────────────────┤
│                                                                  │
│  Logical References (refs):                                     │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐         │
│  │  ref-1      │───▶│  Hash: ABC  │    │             │         │
│  └─────────────┘    └─────────────┘    │             │         │
│  ┌─────────────┐         ▲              │             │         │
│  │  ref-2      │─────────┘              │             │         │
│  └─────────────┘    ┌─────────────┐    │             │         │
│  ┌─────────────┐    │  Hash: XYZ  │    │             │         │
│  │  ref-3      │───▶│             │    │             │         │
│  └─────────────┘    └─────────────┘    │             │         │
│                                      Physical Storage:        │
│                                      ┌─────────────┐            │
│                                      │  ABC: data  │            │
│                                      └─────────────┘            │
│                                      ┌─────────────┐            │
│                                      │  XYZ: data  │            │
│                                      └─────────────┘            │
│                                                                  │
└─────────────────────────────────────────────────────────────┘
```

### Deletion Semantics

#### Soft Delete
- **Operation**: Mark content as deleted
- **Effect**: Content is hidden but not removed
- **Recovery**: Can be restored
- **Use Case**: Temporary deletion, testing, compliance

#### Hard Delete
- **Operation**: Permanently remove content
- **Effect**: Content is physically deleted from storage
- **Recovery**: Not possible (without backup)
- **Use Case**: Permanent cleanup, GDPR compliance

#### Reference Counting
- **Mechanism**: Track how many refs point to each content hash
- **Purpose**: Prevent deletion of content that's still referenced
- **Behavior**: Hard delete only allowed when ref count = 0

---

## 📐 API Design

### Delete Method

```typescript
export interface ContentStore {
  readonly retention_scope: RetentionScope;
  
  // Existing methods
  put(ref: string, bytes: Uint8Array): Promise<void>;
  get(ref: string): Promise<Uint8Array | null>;
  has(ref: string): Promise<boolean>;
  
  // New delete method
  delete(ref: string, options: DeleteOptions): Promise<DeleteResult>;
  
  // New sweep method
  sweep(live: Set<string>): Promise<number>;
}

export interface DeleteOptions {
  // Deletion mode
  mode: 'soft' | 'hard';
  
  // Confirmation string to prevent accidental deletion
  confirmation: string;
  
  // Optional: Override tenant context
  tenantId?: string;
  
  // Optional: Force deletion even if referenced (DANGEROUS)
  force?: boolean;
  
  // Optional: Custom reason for audit log
  reason?: string;
}

export interface DeleteResult {
  // Whether the deletion was successful
  deleted: boolean;
  
  // Number of bytes removed (0 for soft delete)
  bytesRemoved: number;
  
  // References that still point to this content
  remainingRefs: string[];
  
  // Whether the content was physically removed from storage
  physicallyRemoved: boolean;
  
  // Timestamp of deletion
  deletedAt: string;
  
  // Reference to the deleted content
  ref: string;
  
  // Content hash of the deleted content
  hash: string;
}
```

### Sweep Method

The `sweep` method removes content that is no longer referenced:

```typescript
// Remove all content not in the 'live' set
const removedCount = await store.sweep(new Set(['ref-1', 'ref-2', 'ref-3']));
```

---

## 🔧 Implementation

### Directory Structure

```
adapters/content-local/
├── src/
│   ├── index.ts                    # Main ContentStore implementation
│   ├── deletion.ts                 # Deletion logic
│   ├── reference-counter.ts        # Reference counting
│   ├── audit-logger.ts             # Audit logging
│   ├── types.ts                    # Type definitions
│   └── utils.ts                    # Utilities
├── test/
│   ├── deletion.test.ts            # Deletion tests
│   ├── reference-counter.test.ts   # Reference counting tests
│   ├── audit-logger.test.ts        # Audit logging tests
│   └── integration.test.ts         # Integration tests
├── package.json
└── tsconfig.json
```

### Reference Counter

```typescript
// adapters/content-local/src/reference-counter.ts

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

interface ReferenceCount {
  hash: string;
  refs: Set<string>;
  tenantId: string;
  createdAt: string;
  updatedAt: string;
}

class ReferenceCounter {
  private storagePath: string;
  private counts: Map<string, ReferenceCount> = new Map();
  private loaded: boolean = false;

  constructor(storagePath: string = '/tmp/nexusprompt/refs') {
    this.storagePath = storagePath;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    
    try {
      const files = await this.readDirectory(this.storagePath);
      
      for (const file of files) {
        if (file.endsWith('.json')) {
          const content = readFileSync(join(this.storagePath, file), 'utf8');
          const count: ReferenceCount = JSON.parse(content);
          this.counts.set(this.getKey(count.tenantId, count.hash), count);
        }
      }
      
      this.loaded = true;
    } catch (error) {
      // Directory doesn't exist yet
      await this.ensureDirectory(this.storagePath);
      this.loaded = true;
    }
  }

  private getKey(tenantId: string, hash: string): string {
    return `${tenantId}:${hash}`;
  }

  private async ensureDirectory(path: string): Promise<void> {
    // Implementation depends on environment
    // For Node.js:
    import { mkdirSync } from 'node:fs';
    import { dirname } from 'node:path';
    
    try {
      mkdirSync(path, { recursive: true });
    } catch (error) {
      // Already exists
    }
  }

  private async readDirectory(path: string): Promise<string[]> {
    import { readdirSync } from 'node:fs';
    return readdirSync(path);
  }

  async addRef(tenantId: string, hash: string, ref: string): Promise<void> {
    await this.load();
    
    const key = this.getKey(tenantId, hash);
    let count = this.counts.get(key);
    
    if (!count) {
      count = {
        hash,
        refs: new Set(),
        tenantId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.counts.set(key, count);
    }
    
    count.refs.add(ref);
    count.updatedAt = new Date().toISOString();
    
    await this.persist(count);
  }

  async removeRef(tenantId: string, hash: string, ref: string): Promise<boolean> {
    await this.load();
    
    const key = this.getKey(tenantId, hash);
    const count = this.counts.get(key);
    
    if (!count) {
      return false;
    }
    
    const hadRef = count.refs.delete(ref);
    count.updatedAt = new Date().toISOString();
    
    if (count.refs.size === 0) {
      this.counts.delete(key);
      await this.deleteFile(key);
    } else {
      await this.persist(count);
    }
    
    return hadRef;
  }

  async getRefCount(tenantId: string, hash: string): Promise<number> {
    await this.load();
    
    const key = this.getKey(tenantId, hash);
    const count = this.counts.get(key);
    
    return count ? count.refs.size : 0;
  }

  async getRefs(tenantId: string, hash: string): Promise<string[]> {
    await this.load();
    
    const key = this.getKey(tenantId, hash);
    const count = this.counts.get(key);
    
    return count ? Array.from(count.refs) : [];
  }

  private async persist(count: ReferenceCount): Promise<void> {
    const key = this.getKey(count.tenantId, count.hash);
    const path = join(this.storagePath, `${key}.json`);
    
    writeFileSync(path, JSON.stringify(count, null, 2), 'utf8');
  }

  private async deleteFile(key: string): Promise<void> {
    import { unlinkSync } from 'node:fs';
    const path = join(this.storagePath, `${key}.json`);
    
    try {
      unlinkSync(path);
    } catch (error) {
      // File doesn't exist
    }
  }

  async clear(): Promise<void> {
    this.counts.clear();
    this.loaded = false;
  }
}

export { ReferenceCounter };
```

### Audit Logger

```typescript
// adapters/content-local/src/audit-logger.ts

import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

interface AuditEntry {
  id: string;
  timestamp: string;
  operation: 'DELETE_SOFT' | 'DELETE_HARD' | 'SWEEP';
  tenantId: string;
  ref: string;
  hash: string;
  mode: 'soft' | 'hard';
  bytesRemoved: number;
  remainingRefs: string[];
  physicallyRemoved: boolean;
  reason?: string;
  userId?: string;
  ipAddress?: string;
}

class AuditLogger {
  private logPath: string;
  private entries: AuditEntry[] = [];
  private maxEntries: number;

  constructor(logPath: string = '/tmp/nexusprompt/audit', maxEntries: number = 10000) {
    this.logPath = logPath;
    this.maxEntries = maxEntries;
    
    // Ensure directory exists
    this.ensureDirectory();
  }

  private ensureDirectory(): void {
    try {
      mkdirSync(this.logPath, { recursive: true });
    } catch (error) {
      // Already exists
    }
  }

  log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): AuditEntry {
    const auditEntry: AuditEntry = {
      id: this.generateId(),
      timestamp: new Date().toISOString(),
      ...entry,
    };
    
    this.entries.push(auditEntry);
    
    // Trim if over max
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
    
    // Persist
    this.persist(auditEntry);
    
    return auditEntry;
  }

  private generateId(): string {
    return `audit-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private persist(entry: AuditEntry): void {
    const date = new Date(entry.timestamp).toISOString().split('T')[0];
    const path = join(this.logPath, `${date}.jsonl`);
    
    writeFileSync(path, JSON.stringify(entry) + '\n', { flag: 'a' });
  }

  async query(options: {
    tenantId?: string;
    ref?: string;
    hash?: string;
    operation?: AuditEntry['operation'];
    since?: string;
    until?: string;
    limit?: number;
  }): Promise<AuditEntry[]> {
    // In a real implementation, this would query the persisted files
    // For now, just filter the in-memory entries
    return this.entries
      .filter(entry => {
        if (options.tenantId && entry.tenantId !== options.tenantId) return false;
        if (options.ref && entry.ref !== options.ref) return false;
        if (options.hash && entry.hash !== options.hash) return false;
        if (options.operation && entry.operation !== options.operation) return false;
        if (options.since && entry.timestamp < options.since) return false;
        if (options.until && entry.timestamp > options.until) return false;
        return true;
      })
      .slice(0, options.limit);
  }

  async getById(id: string): Promise<AuditEntry | null> {
    return this.entries.find(e => e.id === id) || null;
  }

  async clear(): Promise<void> {
    this.entries = [];
  }
}

export { AuditLogger, AuditEntry };
```

### Main ContentStore with Deletion

```typescript
// adapters/content-local/src/index.ts

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

import type { ContentStore, RetentionScope } from "../../../contracts/index.js";
import { ReferenceCounter } from "./reference-counter.js";
import { AuditLogger } from "./audit-logger.js";
import type { DeleteOptions, DeleteResult } from "./types.js";

export class LocalContentStore implements ContentStore {
  readonly retention_scope: RetentionScope = 'LOCAL_BUNDLE';
  
  private storagePath: string;
  private refCounter: ReferenceCounter;
  private auditLogger: AuditLogger;
  private deletedPath: string;

  constructor(storagePath: string = '/tmp/nexusprompt/content') {
    this.storagePath = storagePath;
    this.deletedPath = join(storagePath, '.deleted');
    this.refCounter = new ReferenceCounter(join(storagePath, '.refs'));
    this.auditLogger = new AuditLogger(join(storagePath, '.audit'));
    
    // Ensure directories exist
    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    [this.storagePath, this.deletedPath].forEach(path => {
      try {
        mkdirSync(path, { recursive: true });
      } catch (error) {
        // Already exists
      }
    });
  }

  private contentPath(ref: string): string {
    return join(this.storagePath, ref);
  }

  private deletedContentPath(ref: string): string {
    return join(this.deletedPath, ref);
  }

  private async computeHash(bytes: Uint8Array): Promise<string> {
    return createHash('sha256').update(bytes).digest('hex');
  }

  // Existing methods

  async put(ref: string, bytes: Uint8Array): Promise<void> {
    const path = this.contentPath(ref);
    const hash = await this.computeHash(bytes);
    
    // Ensure directory exists
    const dir = dirname(path);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      // Already exists
    }
    
    // Write content
    writeFileSync(path, bytes);
    
    // Update reference counter
    await this.refCounter.addRef('default', hash, ref);
  }

  async get(ref: string): Promise<Uint8Array | null> {
    const path = this.contentPath(ref);
    
    if (!existsSync(path)) {
      return null;
    }
    
    return new Uint8Array(readFileSync(path));
  }

  async has(ref: string): Promise<boolean> {
    return existsSync(this.contentPath(ref));
  }

  // New delete method

  async delete(ref: string, options: DeleteOptions): Promise<DeleteResult> {
    // Validate confirmation
    if (!this.validateConfirmation(ref, options.confirmation)) {
      throw new Error('Invalid confirmation string');
    }
    
    const path = this.contentPath(ref);
    const deletedPath = this.deletedContentPath(ref);
    
    // Check if content exists
    if (!existsSync(path)) {
      return {
        deleted: false,
        bytesRemoved: 0,
        remainingRefs: [],
        physicallyRemoved: false,
        deletedAt: new Date().toISOString(),
        ref,
        hash: '',
      };
    }
    
    // Read content to get hash
    const bytes = readFileSync(path);
    const hash = await this.computeHash(bytes);
    
    // Get current reference count
    const refCount = await this.refCounter.getRefCount('default', hash);
    const refs = await this.refCounter.getRefs('default', hash);
    
    // Check if we can hard delete
    const canHardDelete = options.mode === 'hard' && 
      (options.force || refCount <= 1);
    
    if (options.mode === 'hard' && !canHardDelete) {
      throw new Error(
        `Cannot hard delete: ${refCount} refs still point to this content. ` +
        `Use force: true to override or delete all refs first.`
      );
    }
    
    let bytesRemoved = 0;
    let physicallyRemoved = false;
    
    if (options.mode === 'soft') {
      // Soft delete: move to deleted directory
      renameSync(path, deletedPath);
      physicallyRemoved = false;
    } else {
      // Hard delete: remove file
      unlinkSync(path);
      bytesRemoved = bytes.length;
      physicallyRemoved = true;
    }
    
    // Update reference counter
    await this.refCounter.removeRef('default', hash, ref);
    
    // Log audit entry
    this.auditLogger.log({
      operation: options.mode === 'soft' ? 'DELETE_SOFT' : 'DELETE_HARD',
      tenantId: options.tenantId || 'default',
      ref,
      hash,
      mode: options.mode,
      bytesRemoved,
      remainingRefs: await this.refCounter.getRefs('default', hash),
      physicallyRemoved,
      reason: options.reason,
    });
    
    return {
      deleted: true,
      bytesRemoved,
      remainingRefs: await this.refCounter.getRefs('default', hash),
      physicallyRemoved,
      deletedAt: new Date().toISOString(),
      ref,
      hash,
    };
  }

  private validateConfirmation(ref: string, confirmation: string): boolean {
    // Confirmation must be in format: "delete-{ref}"
    return confirmation === `delete-${ref}`;
  }

  // New sweep method

  async sweep(live: Set<string>): Promise<number> {
    const deletedPath = this.deletedPath;
    let count = 0;
    
    // Read all files in storage
    const files = this.readAllFiles(this.storagePath);
    
    for (const file of files) {
      if (!live.has(file) && existsSync(this.contentPath(file))) {
        // File is not in live set, delete it
        try {
          const bytes = readFileSync(this.contentPath(file));
          const hash = await this.computeHash(bytes);
          const refCount = await this.refCounter.getRefCount('default', hash);
          
          if (refCount === 0) {
            // No other refs point to this content, safe to delete
            unlinkSync(this.contentPath(file));
            count++;
            
            // Log sweep
            this.auditLogger.log({
              operation: 'SWEEP',
              tenantId: 'default',
              ref: file,
              hash,
              mode: 'hard',
              bytesRemoved: bytes.length,
              remainingRefs: [],
              physicallyRemoved: true,
              reason: 'Sweep: ref not in live set',
            });
          }
        } catch (error) {
          // Error deleting, skip
          console.error(`Error sweeping ${file}:`, error);
        }
      }
    }
    
    // Also clean up soft-deleted files
    const deletedFiles = this.readAllFiles(this.deletedPath);
    for (const file of deletedFiles) {
      const filePath = this.deletedContentPath(file);
      const livePath = this.contentPath(file);
      
      if (!live.has(file) && existsSync(filePath)) {
        try {
          const bytes = readFileSync(filePath);
          const hash = await this.computeHash(bytes);
          const refCount = await this.refCounter.getRefCount('default', hash);
          
          if (refCount === 0) {
            unlinkSync(filePath);
            count++;
          }
        } catch (error) {
          // Error deleting, skip
          console.error(`Error sweeping deleted ${file}:`, error);
        }
      }
    }
    
    return count;
  }

  private readAllFiles(dir: string): string[] {
    import { readdirSync } from 'node:fs';
    
    try {
      return readdirSync(dir);
    } catch (error) {
      return [];
    }
  }

  // Utility method to restore soft-deleted content
  async restore(ref: string): Promise<boolean> {
    const deletedPath = this.deletedContentPath(ref);
    const path = this.contentPath(ref);
    
    if (!existsSync(deletedPath)) {
      return false;
    }
    
    // Move back to main storage
    renameSync(deletedPath, path);
    
    // Update reference counter
    const bytes = readFileSync(path);
    const hash = await this.computeHash(bytes);
    await this.refCounter.addRef('default', hash, ref);
    
    // Log restore
    this.auditLogger.log({
      operation: 'DELETE_SOFT', // Using soft delete operation for restore
      tenantId: 'default',
      ref,
      hash,
      mode: 'soft',
      bytesRemoved: 0,
      remainingRefs: await this.refCounter.getRefs('default', hash),
      physicallyRemoved: false,
      reason: 'Restore from soft delete',
    });
    
    return true;
  }
}

export { LocalContentStore };
```

---

## 🧪 Testing Strategy

### Unit Tests

| Component | Tests | Coverage Target |
|-----------|-------|-----------------|
| ReferenceCounter | 15 | 95% |
| AuditLogger | 10 | 95% |
| Delete Operation | 20 | 95% |
| Sweep Operation | 10 | 95% |
| Confirmation Mechanism | 10 | 95% |
| **Total** | **65** | **95%** |

### Integration Tests

| Scenario | Tests |
|----------|-------|
| End-to-end deletion | 5 |
| Reference counting | 5 |
| Soft delete + restore | 5 |
| Hard delete | 5 |
| Sweep operation | 5 |
| Multi-tenant isolation | 5 |
| **Total** | **30** |

### Test Example

```typescript
// test/deletion.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LocalContentStore } from '../src/index.js';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

describe('LocalContentStore - Deletion', () => {
  let store: LocalContentStore;
  let tempDir: string;

  beforeEach(() => {
    tempDir = `/tmp/nexusprompt-test-${Date.now()}`;
    store = new LocalContentStore(tempDir);
  });

  afterEach(() => {
    // Clean up temp directory
    import { rmSync } from 'node:fs';
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore
    }
  });

  describe('put and get', () => {
    it('should store and retrieve content', async () => {
      const ref = 'test-ref-1';
      const content = new TextEncoder().encode('Hello, World!');
      
      await store.put(ref, content);
      
      const result = await store.get(ref);
      
      expect(result).not.toBeNull();
      expect(result).toEqual(content);
    });

    it('should return null for non-existent ref', async () => {
      const result = await store.get('non-existent');
      expect(result).toBeNull();
    });
  });

  describe('delete - soft mode', () => {
    it('should soft delete content', async () => {
      const ref = 'test-ref-2';
      const content = new TextEncoder().encode('Soft delete test');
      
      await store.put(ref, content);
      
      const result = await store.delete(ref, {
        mode: 'soft',
        confirmation: `delete-${ref}`,
      });
      
      expect(result.deleted).toBe(true);
      expect(result.physicallyRemoved).toBe(false);
      expect(result.bytesRemoved).toBe(0);
      expect(result.ref).toBe(ref);
      
      // Content should not be accessible via get
      const getResult = await store.get(ref);
      expect(getResult).toBeNull();
      
      // But file should still exist in deleted directory
      // (This is an implementation detail, but good for testing)
    });

    it('should require valid confirmation', async () => {
      const ref = 'test-ref-3';
      const content = new TextEncoder().encode('Confirmation test');
      
      await store.put(ref, content);
      
      await expect(
        store.delete(ref, {
          mode: 'soft',
          confirmation: 'invalid',
        })
      ).rejects.toThrow('Invalid confirmation string');
    });
  });

  describe('delete - hard mode', () => {
    it('should hard delete content when no other refs', async () => {
      const ref = 'test-ref-4';
      const content = new TextEncoder().encode('Hard delete test');
      
      await store.put(ref, content);
      
      const result = await store.delete(ref, {
        mode: 'hard',
        confirmation: `delete-${ref}`,
      });
      
      expect(result.deleted).toBe(true);
      expect(result.physicallyRemoved).toBe(true);
      expect(result.bytesRemoved).toBe(content.length);
      expect(result.ref).toBe(ref);
      
      // Content should not be accessible
      const getResult = await store.get(ref);
      expect(getResult).toBeNull();
    });

    it('should not hard delete when other refs exist', async () => {
      const ref1 = 'test-ref-5';
      const ref2 = 'test-ref-6';
      const content = new TextEncoder().encode('Shared content');
      
      await store.put(ref1, content);
      await store.put(ref2, content);
      
      await expect(
        store.delete(ref1, {
          mode: 'hard',
          confirmation: `delete-${ref1}`,
        })
      ).rejects.toThrow(/Cannot hard delete.*refs still point/);
    });

    it('should hard delete with force when other refs exist', async () => {
      const ref1 = 'test-ref-7';
      const ref2 = 'test-ref-8';
      const content = new TextEncoder().encode('Forced delete test');
      
      await store.put(ref1, content);
      await store.put(ref2, content);
      
      const result = await store.delete(ref1, {
        mode: 'hard',
        confirmation: `delete-${ref1}`,
        force: true,
      });
      
      expect(result.deleted).toBe(true);
      expect(result.physicallyRemoved).toBe(true);
      
      // ref1 should not be accessible
      expect(await store.get(ref1)).toBeNull();
      
      // ref2 should still be accessible (but will fail on get because content is gone)
      // This is a known limitation of force delete
    });
  });

  describe('sweep', () => {
    it('should remove content not in live set', async () => {
      const ref1 = 'test-ref-9';
      const ref2 = 'test-ref-10';
      const content1 = new TextEncoder().encode('Live content');
      const content2 = new TextEncoder().encode('Dead content');
      
      await store.put(ref1, content1);
      await store.put(ref2, content2);
      
      // Sweep with only ref1 in live set
      const removed = await store.sweep(new Set([ref1]));
      
      expect(removed).toBe(1);
      
      // ref1 should still be accessible
      expect(await store.get(ref1)).not.toBeNull();
      
      // ref2 should not be accessible
      expect(await store.get(ref2)).toBeNull();
    });
  });

  describe('restore', () => {
    it('should restore soft-deleted content', async () => {
      const ref = 'test-ref-11';
      const content = new TextEncoder().encode('Restore test');
      
      await store.put(ref, content);
      
      // Soft delete
      await store.delete(ref, {
        mode: 'soft',
        confirmation: `delete-${ref}`,
      });
      
      // Content should not be accessible
      expect(await store.get(ref)).toBeNull();
      
      // Restore
      const restored = await store.restore(ref);
      expect(restored).toBe(true);
      
      // Content should be accessible again
      const result = await store.get(ref);
      expect(result).not.toBeNull();
      expect(result).toEqual(content);
    });
  });
});
```

---

## 📊 Performance Considerations

### Reference Counting Overhead
- **Memory**: ~100 bytes per reference entry
- **CPU**: O(1) for add/remove operations
- **Disk I/O**: One write per reference change

### Deletion Performance
- **Soft delete**: O(1) - just a file move
- **Hard delete**: O(1) - file deletion + reference count update
- **Sweep**: O(n) where n = number of files to check

### Caching
- Reference counts cached in memory
- Audit logs buffered and flushed periodically

---

## 🔒 Security Considerations

### Confirmation Mechanism
- **Format**: `delete-{ref}`
- **Purpose**: Prevent accidental deletion
- **Validation**: Exact string match required

### Tenant Isolation
- All operations scoped to tenant
- No cross-tenant reference counting
- No cross-tenant deletion

### Audit Trail
- All deletions logged
- Logs include: who, what, when, why
- Logs are immutable (append-only)

### Force Delete
- **Dangerous**: Can delete content still referenced
- **Use case**: Emergency cleanup, data corruption
- **Protection**: Requires explicit `force: true` flag

---

## 📝 Monitoring and Observability

### Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `content.delete.soft` | Counter | Soft deletions |
| `content.delete.hard` | Counter | Hard deletions |
| `content.delete.bytes` | Counter | Bytes deleted |
| `content.sweep.count` | Counter | Sweep operations |
| `content.sweep.removed` | Counter | Items removed by sweep |
| `content.refs.count` | Gauge | Current reference count |
| `content.delete.failed` | Counter | Failed deletions |

### Logging

| Level | Usage |
|-------|-------|
| DEBUG | Detailed deletion logging |
| INFO | High-level deletion operations |
| WARN | Force deletes, potential data loss |
| ERROR | Deletion failures |

**Log Format:**
```json
{
  "timestamp": "2026-09-01T10:00:00.000Z",
  "level": "INFO",
  "message": "Content deleted",
  "operation": "DELETE_SOFT",
  "tenantId": "default",
  "ref": "test-ref-1",
  "hash": "abc123...",
  "mode": "soft",
  "bytesRemoved": 0,
  "remainingRefs": [],
  "physicallyRemoved": false
}
```

---

## 🚀 Deployment

### Configuration

```bash
# Storage paths
export CONTENT_STORAGE_PATH='/var/lib/nexusprompt/content'
export CONTENT_REF_PATH='/var/lib/nexusprompt/refs'
export CONTENT_AUDIT_PATH='/var/lib/nexusprompt/audit'

# Retention policies
export CONTENT_RETENTION_SCOPE='DB'
export CONTENT_MAX_AGE_DAYS='30'
```

### Backup Strategy

1. **Content**: Regular filesystem backup
2. **Reference counts**: Included in content backup
3. **Audit logs**: Separate backup with longer retention

### Disaster Recovery

1. **Restore from backup**: Replace storage directory
2. **Rebuild reference counts**: Scan all content and rebuild refs
3. **Replay audit logs**: Reconstruct deletion history

---

## 📝 Specification Metadata

| Field | Value |
|-------|-------|
| **Version** | 1.0.0 |
| **Last Updated** | September 2026 |
| **Owner** | Core Team |
| **Phase** | Phase 2 (Week 19) |
| **Effort** | 20-25 hours |
| **Priority** | P1 |
| **Status** | Draft |
| **Repository** | hynix666/nexusprompt |
| **Related Documents** | [IMPROVEMENT_2026_REVISED.md](../../IMPROVEMENT_2026_REVISED.md) |

---

## 🔗 References

- [ContentStore Interface](../../../contracts/index.ts)
- [RetentionScope Type](../../../contracts/index.ts)
- [Content Addressing](https://en.wikipedia.org/wiki/Content-addressable_storage)
- [Reference Counting](https://en.wikipedia.org/wiki/Reference_counting)
- [Soft Delete Pattern](https://martinfowler.com/bliki/SoftDelete.html)
