
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

// =============================================
// REPUTATION (Score-based label derivation)
// =============================================

export const REPUTATION_THRESHOLDS = {
    ALLEATO: 50,
    AMICHEVOLE: 25,
    CORDIALE: 10,
    FREDDO: -10,
    DIFFIDENTE: -25,
    OSTILE: -50
};

export type ReputationLevel = 'OSTILE' | 'DIFFIDENTE' | 'FREDDO' | 'NEUTRALE' | 'CORDIALE' | 'AMICHEVOLE' | 'ALLEATO';

export function getReputationLabel(score: number): ReputationLevel {
    if (score <= REPUTATION_THRESHOLDS.OSTILE) return 'OSTILE';
    if (score <= REPUTATION_THRESHOLDS.DIFFIDENTE) return 'DIFFIDENTE';
    if (score <= REPUTATION_THRESHOLDS.FREDDO) return 'FREDDO';
    if (score >= REPUTATION_THRESHOLDS.ALLEATO) return 'ALLEATO';
    if (score >= REPUTATION_THRESHOLDS.AMICHEVOLE) return 'AMICHEVOLE';
    if (score >= REPUTATION_THRESHOLDS.CORDIALE) return 'CORDIALE';
    return 'NEUTRALE';
}

/**
 * Returns the score threshold for a given reputation label.
 * Used when DM manually sets a label to sync the numeric score.
 */
export function getReputationScoreForLabel(label: ReputationLevel): number {
    switch (label) {
        case 'OSTILE': return REPUTATION_THRESHOLDS.OSTILE;
        case 'DIFFIDENTE': return REPUTATION_THRESHOLDS.DIFFIDENTE;
        case 'FREDDO': return REPUTATION_THRESHOLDS.FREDDO;
        case 'CORDIALE': return REPUTATION_THRESHOLDS.CORDIALE;
        case 'AMICHEVOLE': return REPUTATION_THRESHOLDS.AMICHEVOLE;
        case 'ALLEATO': return REPUTATION_THRESHOLDS.ALLEATO;
        default: return 0; // NEUTRALE
    }
}

// =============================================
// ALIGNMENT SPECTRUM VISUALIZATION
// =============================================

/**
 * Role-based weight multipliers for member alignment contribution
 */
export const ROLE_WEIGHTS: Record<string, number> = {
    'LEADER': 1.0,    // Leaders fully represent the faction
    'MEMBER': 0.5,    // Members contribute half weight
    'ALLY': 0.25,     // Allies contribute quarter weight
    'ENEMY': 0,       // Enemies don't contribute
    'CONTROLLED': 0,  // Locations don't contribute
    'HQ': 0
};

/**
 * Formats a single alignment axis as a colored spectrum bar
 * @param score - The alignment score
 * @param leftIcon - Icon for the left side (positive values)
 * @param rightIcon - Icon for the right side (negative values)
 * @param leftLabel - Label for left extreme
 * @param rightLabel - Label for right extreme
 */
export function formatAlignmentBar(
    score: number,
    leftIcon: string,
    rightIcon: string,
    leftLabel: string,
    rightLabel: string
): string {
    // Clamp score to -100..+100 for display purposes
    const clampedScore = Math.max(-100, Math.min(100, score));

    // Map score to position 0-8 (9 segments)
    // -100 -> 8 (far right), 0 -> 4 (center), +100 -> 0 (far left)
    const position = Math.round(4 - (clampedScore / 100) * 4);

    // Color gradients (left=positive, right=negative)
    const leftColors = ['🟩', '🟩', '🟨', '⬜', '⬜', '⬜', '🟨', '🟥', '🟥'];
    const rightColors = ['🟦', '🟦', '🟨', '⬜', '⬜', '⬜', '🟨', '🟪', '🟪'];

    // Choose color set based on axis (we'll use leftColors for moral, rightColors for ethical)
    const isEthicalAxis = leftLabel === 'Legale';
    const colors = isEthicalAxis ? rightColors : leftColors;

    // Build the bar with position marker
    let bar = '';
    for (let i = 0; i < 9; i++) {
        if (i === position) {
            bar += '▼';
        } else {
            bar += colors[i];
        }
    }

    // Format: Icon [spectrum] Icon (score)
    const signedScore = score >= 0 ? `+${score}` : `${score}`;
    return `${leftIcon} ${bar} ${rightIcon}  \`${signedScore}\``;
}

/**
 * Formats complete alignment display with two spectrum bars
 */
export function formatAlignmentSpectrum(moralScore: number, ethicalScore: number): string {
    const moralBar = formatAlignmentBar(moralScore, '😇', '😈', 'Buono', 'Cattivo');
    const ethicalBar = formatAlignmentBar(ethicalScore, '📜', '🌀', 'Legale', 'Caotico');

    return `**Morale**\n${moralBar}\n**Etico**\n${ethicalBar}`;
}

/**
 * Compact single-line alignment display
 */
export function formatAlignmentCompact(moralScore: number, ethicalScore: number): string {
    const mLabel = getMoralAlignment(moralScore);
    const eLabel = getEthicalAlignment(ethicalScore);

    const moralIcon = mLabel === 'BUONO' ? '😇' : mLabel === 'CATTIVO' ? '😈' : '⚖️';
    const ethicalIcon = eLabel === 'LEGALE' ? '📜' : eLabel === 'CAOTICO' ? '🌀' : '⚖️';

    // Mini spectrum (5 segments)
    const mPos = Math.round(2 - (Math.max(-100, Math.min(100, moralScore)) / 100) * 2);
    const ePos = Math.round(2 - (Math.max(-100, Math.min(100, ethicalScore)) / 100) * 2);

    const buildMiniBar = (pos: number, leftC: string, rightC: string) => {
        const segments = [leftC, '🟨', '⬜', '🟨', rightC];
        return segments.map((c, i) => i === pos ? '●' : c).join('');
    };

    const mBar = buildMiniBar(mPos, '🟩', '🟥');
    const eBar = buildMiniBar(ePos, '🟦', '🟪');

    return `${moralIcon}${mBar}${ethicalIcon}${eBar}`;
}
