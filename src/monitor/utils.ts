/**
 * Monitor - Resource Utils
 */

import * as fs from 'fs';

export function checkDiskSpace(pathToCheck: string = '.') {
    try {
        const stats = fs.statfsSync(pathToCheck);
        const totalGB = (stats.bsize * stats.blocks) / (1024 * 1024 * 1024);
        const freeGB = (stats.bsize * stats.bavail) / (1024 * 1024 * 1024);
        const usedPercent = ((totalGB - freeGB) / totalGB) * 100;

        return {
            totalGB: parseFloat(totalGB.toFixed(2)),
            freeGB: parseFloat(freeGB.toFixed(2)),
            usedPercent: parseFloat(usedPercent.toFixed(1))
        };
    } catch (e) {
        console.error("[Monitor] Errore lettura disco:", e);
        return null;
    }
}
