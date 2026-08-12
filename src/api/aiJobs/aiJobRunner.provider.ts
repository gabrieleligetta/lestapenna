import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { AiJobRunner } from '../../services/aiJobs/runner';
import { registerAiJobSweeper } from '../../services/aiJobs/janitor';
import { ImageGenerationService } from '../campaigns/imageGeneration.service';
import { EntityProfileService } from '../campaigns/entityProfile.service';
import { QuestAuditService } from '../campaigns/questAudit.service';
import { CharacterBioService } from '../campaigns/characterBio.service';

/**
 * The runner, wired to the services that know how to do each kind of work.
 *
 * The handler map is typed `Record<AiJobKind, …>` on purpose: adding a kind to
 * the register without teaching anybody to run it does not compile. That is the
 * exhaustiveness a registry of dynamically registered plugins would have thrown
 * away, for four kinds and no benefit.
 *
 * It lives on the Nest lifecycle rather than in the Discord `ready` handler,
 * where the audio workers start: this work is asked for over HTTP and must run
 * whether or not a chat gateway ever connects — and the API-only preview has no
 * Discord client at all.
 */
@Injectable()
export class AiJobRunnerProvider implements OnApplicationBootstrap, OnApplicationShutdown {
    private readonly runner: AiJobRunner;

    constructor(
        images: ImageGenerationService,
        profiles: EntityProfileService,
        quests: QuestAuditService,
        bios: CharacterBioService,
    ) {
        this.runner = new AiJobRunner({
            'image': images,
            'appearance': profiles,
            'quest-audit': quests,
            'character-bio': bios,
        });
    }

    onApplicationBootstrap(): void {
        this.runner.start();
        registerAiJobSweeper();
    }

    onApplicationShutdown(): void {
        this.runner.stop();
    }

    /** For the tests, which drive the runner rather than waiting on a timer. */
    get instance(): AiJobRunner {
        return this.runner;
    }
}
