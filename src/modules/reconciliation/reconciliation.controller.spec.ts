import { describe, expect, it, vi } from 'vitest';
import { ReconciliationController } from './reconciliation.controller.js';

describe('ReconciliationController', () => {
  it('returns the reconciliation service result', async () => {
    const result = { date: '2025-01-01', matched: 2 };
    const runReconciliation = vi.fn().mockResolvedValue(result);
    const controller = new ReconciliationController({
      runReconciliation,
    } as never);
    await expect(controller.run({ date: '2025-01-01' } as never)).resolves.toBe(
      result,
    );
    expect(runReconciliation).toHaveBeenCalledWith('2025-01-01');
  });
});
