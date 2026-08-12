
import { computeAggregatedAlignmentScore } from '../../../src/utils/alignmentUtils';

describe('computeAggregatedAlignmentScore', () => {
    it('returns 0 for an empty list', () => {
        expect(computeAggregatedAlignmentScore([])).toBe(0);
    });

    it('returns 0 when all weights are zero (e.g. only FIRST_APPEARANCE/BACKGROUND events)', () => {
        expect(computeAggregatedAlignmentScore([0, 0, 0])).toBe(0);
    });

    it('excludes zero-weight rows from the average instead of diluting it', () => {
        // A single -8 event mixed with two zero-weight events should average as if the
        // zeros were never there: -8 * 10 = -80, not (-8+0+0)/3*10.
        expect(computeAggregatedAlignmentScore([0, -8, 0])).toBe(-80);
    });

    it('a single high-magnitude event can alone determine the score (accepted simple-average behavior)', () => {
        // Helena-style case: one BETRAYAL event, no corroborating history.
        expect(computeAggregatedAlignmentScore([-8])).toBe(-80);
        expect(computeAggregatedAlignmentScore([-7])).toBe(-70);
    });

    it('averages multiple nonzero weights', () => {
        expect(computeAggregatedAlignmentScore([-4, -4])).toBe(-40);
        expect(computeAggregatedAlignmentScore([5, -5])).toBe(0);
    });

    it('clamps to -100..100', () => {
        expect(computeAggregatedAlignmentScore([-10, -10, -10])).toBe(-100);
        expect(computeAggregatedAlignmentScore([10, 10])).toBe(100);
    });

    it('rounds to the nearest integer', () => {
        // avg = -3.333..., *10 = -33.33... -> rounds to -33
        expect(computeAggregatedAlignmentScore([-5, -3, -2])).toBe(-33);
    });
});
