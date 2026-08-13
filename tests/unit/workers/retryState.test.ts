import { isFinalAttempt } from '../../../src/workers/retryState';

describe('worker retry state', () => {
    it('keeps every non-final BullMQ attempt retryable', () => {
        expect(isFinalAttempt(0, 5)).toBe(false);
        expect(isFinalAttempt(1, 5)).toBe(false);
        expect(isFinalAttempt(3, 5)).toBe(false);
    });

    it('marks only the last configured attempt terminal', () => {
        expect(isFinalAttempt(4, 5)).toBe(true);
        expect(isFinalAttempt(0, 1)).toBe(true);
        expect(isFinalAttempt(0, undefined)).toBe(true);
    });
});
