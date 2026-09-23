import { describe, expect, it } from 'vitest';
import { queueNames } from './queues.js';

describe('queue registry', () => {
  it('declares every foundation queue', () => expect(queueNames).toEqual(['default', 'email', 'notifications', 'scans', 'monitoring', 'backups', 'reports', 'ai']));
});
