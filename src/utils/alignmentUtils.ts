
export const ALIGNMENT_THRESHOLDS = {
    GOOD: 25,
    EVIL: -25,
    LAWFUL: 25,
    CHAOTIC: -25
};

export type MoralAlignment = 'BUONO' | 'NEUTRALE' | 'CATTIVO';
export type EthicalAlignment = 'LEGALE' | 'NEUTRALE' | 'CAOTICO';

export function getMoralAlignment(score: number): MoralAlignment {
    if (score >= ALIGNMENT_THRESHOLDS.GOOD) return 'BUONO';
    if (score <= ALIGNMENT_THRESHOLDS.EVIL) return 'CATTIVO';
    return 'NEUTRALE';
}

export function getEthicalAlignment(score: number): EthicalAlignment {
    if (score >= ALIGNMENT_THRESHOLDS.LAWFUL) return 'LEGALE';
    if (score <= ALIGNMENT_THRESHOLDS.CHAOTIC) return 'CAOTICO';
    return 'NEUTRALE';
}

export function getAlignmentLabel(moral: number, ethical: number): string {
    const m = getMoralAlignment(moral);
    const e = getEthicalAlignment(ethical);

    if (m === 'NEUTRALE' && e === 'NEUTRALE') return 'NEUTRALE VERU'; // or just NEUTRALE
    return `${e} ${m}`;
}
