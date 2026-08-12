/**
 * Architectural guards for destructive Discord commands.
 *
 * These assertions deliberately inspect the command sources. Importing the
 * full registry starts the queue/voice dependency tree, while the security
 * property we need to pin is structural: no instance-wide maintenance
 * primitive may be reachable from a Discord command, and every command that
 * purges a caller-supplied session must verify its guild first.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '../../../src');
const COMMANDS = path.join(ROOT, 'commands');

function source(relative: string): string {
    return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function commandSources(): Array<{ file: string; text: string }> {
    const out: Array<{ file: string; text: string }> = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.name.endsWith('.ts')) {
                out.push({ file: path.relative(COMMANDS, full), text: fs.readFileSync(full, 'utf8') });
            }
        }
    };
    walk(COMMANDS);
    return out;
}

describe('destructive command boundaries', () => {
    it('keeps instance-wide maintenance primitives out of every Discord command', () => {
        const forbidden = ['wipeDatabase', 'wipeBucket', 'wipeLocalFiles', 'clearQueue'];
        const violations = commandSources().flatMap(({ file, text }) =>
            forbidden.filter(name => text.includes(name)).map(name => `${file}: ${name}`),
        );
        expect(violations).toEqual([]);
    });

    it('does not offer an all-campaign rebuild', () => {
        const rebuild = source('commands/admin/rebuild.ts');
        expect(rebuild).toContain('getCampaigns(ctx.guildId)');
        expect(rebuild).not.toContain(".setValue('ALL')");
        expect(rebuild).not.toContain('getDiagnostics(undefined)');
    });

    it('checks the guild before destructive session maintenance', () => {
        for (const file of [
            'commands/admin/recover.ts',
            'commands/admin/reprocess.ts',
            'commands/admin/rereconcile.ts',
            'commands/sessions/reset.ts',
        ]) {
            expect(source(file)).toContain('assertSessionInGuild(ctx,');
        }
    });

    it('scopes travel-history mutations to the active campaign and its members', () => {
        const travels = source('commands/locations/travels.ts');
        expect(travels).toContain('assertCampaignWrite(ctx)');
        expect(travels).toContain('short_id = ? AND campaign_id = ?');
    });

    it('protects forced narration reindexing as destructive maintenance', () => {
        const narrate = source('commands/narrative/narrate.ts');
        expect(narrate).toContain('assertCampaignWrite(ctx)');
        expect(narrate).toContain('assertSessionInActiveCampaign(ctx,');
        expect(narrate).toContain('forceReindex && !isGuildOperator(');
    });
});
