import { describe, expect, it, vi } from 'vitest';
import {
  AccountOwnerTypeEnum,
  AccountTypeEnum,
} from '../../common/enums/account.enums.js';
import { CurrencyEnum } from '../../common/enums/currency.enum.js';
import {
  LedgerDirectionEnum,
  LedgerRefTypeEnum,
  LedgerTxTypeEnum,
} from '../../common/enums/ledger.enums.js';
import { LedgerService } from './ledger.service.js';

const userAccount = {
  id: 'a-user',
  ownerType: AccountOwnerTypeEnum.USER,
  ownerId: 'u1',
  accountType: AccountTypeEnum.AVAILABLE,
  currency: CurrencyEnum.IRT,
};
const systemAccount = {
  id: 'a-system',
  ownerType: AccountOwnerTypeEnum.SYSTEM,
  ownerId: 'system',
  accountType: AccountTypeEnum.CLEARING,
  currency: CurrencyEnum.IRT,
};

describe('LedgerService', () => {
  it('writes balanced postings and emits balance changes only for user accounts', async () => {
    const insertedItems = [
      {
        id: 'i1',
        accountId: 'a-user',
        userId: 'u1',
        currency: CurrencyEnum.IRT,
        accountType: AccountTypeEnum.AVAILABLE,
        direction: LedgerDirectionEnum.CREDIT,
        amount: '500',
        balanceAfter: '500',
      },
      {
        id: 'i2',
        accountId: 'a-system',
        userId: null,
        currency: CurrencyEnum.IRT,
        accountType: AccountTypeEnum.CLEARING,
        direction: LedgerDirectionEnum.DEBIT,
        amount: '500',
        balanceAfter: null,
      },
    ];
    const insertCalls: unknown[] = [];
    let insertIndex = 0;
    const tx = {
      insert: vi.fn(() => {
        const call = {
          values: vi.fn((value: unknown) => {
            insertCalls.push(value);
            insertIndex += 1;
            return insertIndex === 2
              ? { returning: vi.fn().mockResolvedValue(insertedItems) }
              : Promise.resolve();
          }),
        };
        return call;
      }),
    };
    const result = await new LedgerService().postTransaction(tx as never, {
      type: LedgerTxTypeEnum.OPS_ADJ,
      referenceType: LedgerRefTypeEnum.ADJUSTMENT,
      referenceId: 'ref-1',
      description: 'credit',
      postings: [
        {
          account: userAccount as never,
          direction: LedgerDirectionEnum.CREDIT,
          amount: 500n,
        },
        {
          account: systemAccount as never,
          direction: LedgerDirectionEnum.DEBIT,
          amount: 500n,
        },
      ],
    });
    expect(tx.insert).toHaveBeenCalledTimes(3);
    expect(insertCalls[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: 'u1', amount: '500' }),
        expect.objectContaining({ userId: null, amount: '500' }),
      ]),
    );
    expect(insertCalls[2]).toMatchObject({
      payload: {
        changes: [
          expect.objectContaining({
            userId: 'u1',
            amount: '500',
            balanceAfter: '500',
          }),
        ],
      },
    });
    expect(result.items[0]).toMatchObject({ amount: 500n, balanceAfter: 500n });
    expect(result.items[1]?.balanceAfter).toBeNull();
  });

  it('rejects fewer than two, non-positive, and unbalanced postings before database writes', async () => {
    const service = new LedgerService();
    const tx = { insert: vi.fn() };
    const base = {
      type: LedgerTxTypeEnum.OPS_ADJ,
      referenceType: LedgerRefTypeEnum.ADJUSTMENT,
      referenceId: 'ref-1',
      postings: [],
    };
    await expect(
      service.postTransaction(tx as never, base as never),
    ).rejects.toThrow(/at least 2/);
    await expect(
      service.postTransaction(
        tx as never,
        {
          ...base,
          postings: [
            {
              account: userAccount,
              direction: LedgerDirectionEnum.DEBIT,
              amount: 0n,
            },
            {
              account: userAccount,
              direction: LedgerDirectionEnum.CREDIT,
              amount: 0n,
            },
          ],
        } as never,
      ),
    ).rejects.toThrow(/must be positive/);
    await expect(
      service.postTransaction(
        tx as never,
        {
          ...base,
          postings: [
            {
              account: userAccount,
              direction: LedgerDirectionEnum.DEBIT,
              amount: 5n,
            },
            {
              account: userAccount,
              direction: LedgerDirectionEnum.CREDIT,
              amount: 4n,
            },
          ],
        } as never,
      ),
    ).rejects.toThrow(/Unbalanced postings/);
    await expect(
      service.postTransaction(
        tx as never,
        {
          ...base,
          postings: [
            {
              account: userAccount,
              direction: LedgerDirectionEnum.DEBIT,
              amount: 5n,
            },
            {
              account: { ...userAccount, currency: CurrencyEnum.USDT },
              direction: LedgerDirectionEnum.CREDIT,
              amount: 5n,
            },
          ],
        } as never,
      ),
    ).rejects.toThrow(/Unbalanced postings/);
    expect(tx.insert).not.toHaveBeenCalled();
  });
});
