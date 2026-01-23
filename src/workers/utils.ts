/**
 * Worker Utils
 */

export function groupWordsIntoSentences(wordSegments: any[]): any[] {
    if (wordSegments.length === 0) return [];

    const PAUSE_THRESHOLD = 2.5; // secondi
    const sentences: any[] = [];
    let currentSentence = {
        start: wordSegments[0].start,
        end: wordSegments[0].end,
        text: wordSegments[0].text.trim()
    };

    for (let i = 1; i < wordSegments.length; i++) {
        const pause = wordSegments[i].start - wordSegments[i - 1].end;

        if (pause > PAUSE_THRESHOLD) {
            // Nuova frase
            sentences.push(currentSentence);
            currentSentence = {
                start: wordSegments[i].start,
                end: wordSegments[i].end,
                text: wordSegments[i].text.trim()
            };
        } else {
            // Continua frase corrente
            currentSentence.text += ' ' + wordSegments[i].text.trim();
            currentSentence.end = wordSegments[i].end;
        }
    }

    if (currentSentence.text) {
        sentences.push(currentSentence);
    }

    return sentences;
}
