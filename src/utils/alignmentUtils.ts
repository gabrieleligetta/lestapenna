
export const ALIGNMENT_THRESHOLDS = {
    GOOD: 25,
    EVIL: -25,
    LAWFUL: 25,
    CHAOTIC: -25
};

export type MoralAlignment = 'GOOD' | 'NEUTRAL' | 'EVIL';
export type EthicalAlignment = 'LAWFUL' | 'NEUTRAL' | 'CHAOTIC';

export function getMoralAlignment(score: number): MoralAlignment {
    if (score >= ALIGNMENT_THRESHOLDS.GOOD) return 'GOOD';
    if (score <= ALIGNMENT_THRESHOLDS.EVIL) return 'EVIL';
    return 'NEUTRAL';
}

export function getEthicalAlignment(score: number): EthicalAlignment {
    if (score >= ALIGNMENT_THRESHOLDS.LAWFUL) return 'LAWFUL';
    if (score <= ALIGNMENT_THRESHOLDS.CHAOTIC) return 'CHAOTIC';
    return 'NEUTRAL';
}

export function getAlignmentLabel(moral: number, ethical: number): string {
    const moralLabel = getMoralAlignment(moral);
    const ethicalLabel = getEthicalAlignment(ethical);

    const mItalian = moralLabel === 'GOOD' ? 'BUONO' : moralLabel === 'EVIL' ? 'CATTIVO' : 'NEUTRALE';
    const eItalian = ethicalLabel === 'LAWFUL' ? 'LEGALE' : ethicalLabel === 'CHAOTIC' ? 'CAOTICO' : 'NEUTRALE';

    if (mItalian === 'NEUTRALE' && eItalian === 'NEUTRALE') return 'NEUTRALE VERO';
    return `${eItalian} ${mItalian}`;
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

export type ReputationLevel = 'HOSTILE' | 'DISTRUSTFUL' | 'COLD' | 'NEUTRAL' | 'CORDIAL' | 'FRIENDLY' | 'ALLIED';

export function translateReputation(rep: ReputationLevel): string {
    const map: Record<ReputationLevel, string> = {
        'HOSTILE': 'Ostile',
        'DISTRUSTFUL': 'Diffidente',
        'COLD': 'Freddo',
        'NEUTRAL': 'Neutrale',
        'CORDIAL': 'Cordiale',
        'FRIENDLY': 'Amichevole',
        'ALLIED': 'Alleato'
    };
    return map[rep] || rep;
}

export function getReputationLabel(score: number): ReputationLevel {
    if (score <= REPUTATION_THRESHOLDS.OSTILE) return 'HOSTILE';
    if (score <= REPUTATION_THRESHOLDS.DIFFIDENTE) return 'DISTRUSTFUL';
    if (score <= REPUTATION_THRESHOLDS.FREDDO) return 'COLD';
    if (score >= REPUTATION_THRESHOLDS.ALLEATO) return 'ALLIED';
    if (score >= REPUTATION_THRESHOLDS.AMICHEVOLE) return 'FRIENDLY';
    if (score >= REPUTATION_THRESHOLDS.CORDIALE) return 'CORDIAL';
    return 'NEUTRAL';
}

/**
 * Returns the score threshold for a given reputation label.
 * Used when DM manually sets a label to sync the numeric score.
 */
export function getReputationScoreForLabel(label: ReputationLevel): number {
    switch (label) {
        case 'HOSTILE': return REPUTATION_THRESHOLDS.OSTILE;
        case 'DISTRUSTFUL': return REPUTATION_THRESHOLDS.DIFFIDENTE;
        case 'COLD': return REPUTATION_THRESHOLDS.FREDDO;
        case 'CORDIAL': return REPUTATION_THRESHOLDS.CORDIALE;
        case 'FRIENDLY': return REPUTATION_THRESHOLDS.AMICHEVOLE;
        case 'ALLIED': return REPUTATION_THRESHOLDS.ALLEATO;
        default: return 0; // NEUTRAL
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
    'HQ': 0,
    'PRESENCE': 0,    // Passive presence, no alignment contribution
    'HOSTILE': 0,     // Hostile entities don't contribute
    'PRISONER': 0     // Prisoners don't contribute
};

/**
 * Role priority for merge conflict resolution.
 * Higher value = higher priority role is kept.
 */
export const ROLE_PRIORITY: Record<string, number> = {
    'LEADER': 6,
    'HQ': 5,
    'MEMBER': 4,
    'CONTROLLED': 3,
    'ALLY': 2,
    'PRESENCE': 1,
    'ENEMY': 0,
    'HOSTILE': 0,
    'PRISONER': 0
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
    rightLabel: string,
    axisLabel: string
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

    // Format: Icon [spectrum] Icon  `LABEL (score)`
    const signedScore = score >= 0 ? `+${score}` : `${score}`;
    return `${leftIcon} ${bar} ${rightIcon}  \`${axisLabel} (${signedScore})\``;
}

/**
 * Formats complete alignment display with two spectrum bars
 */
export function formatAlignmentSpectrum(moralScore: number, ethicalScore: number): string {
    const moralAxisLabel = getMoralAlignment(moralScore) === 'GOOD' ? 'BUONO'
        : getMoralAlignment(moralScore) === 'EVIL' ? 'CATTIVO' : 'NEUTRALE';
    const ethicalAxisLabel = getEthicalAlignment(ethicalScore) === 'LAWFUL' ? 'LEGALE'
        : getEthicalAlignment(ethicalScore) === 'CHAOTIC' ? 'CAOTICO' : 'NEUTRALE';

    const moralBar = formatAlignmentBar(moralScore, '😇', '😈', 'Buono', 'Cattivo', moralAxisLabel);
    const ethicalBar = formatAlignmentBar(ethicalScore, '📜', '🌀', 'Legale', 'Caotico', ethicalAxisLabel);

    const fullLabel = getAlignmentLabel(moralScore, ethicalScore);

    return `**Morale**\n${moralBar}\n**Etico**\n${ethicalBar}\n⚖️ **${fullLabel}**`;
}

/**
 * Compact single-line alignment display
 */
export function formatAlignmentCompact(moralScore: number, ethicalScore: number): string {
    const mLabel = getMoralAlignment(moralScore);
    const eLabel = getEthicalAlignment(ethicalScore);

    const moralIcon = mLabel === 'GOOD' ? '😇' : mLabel === 'EVIL' ? '😈' : '⚖️';
    const ethicalIcon = eLabel === 'LAWFUL' ? '📜' : eLabel === 'CHAOTIC' ? '🌀' : '⚖️';

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
