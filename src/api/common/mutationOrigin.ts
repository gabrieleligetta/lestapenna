import { BadRequestException } from '@nestjs/common';
import { config } from '../../config';
import type { AuthenticatedRequest } from '../auth/types';

/**
 * Rejects cross-origin mutations: the first anti-CSRF line, on top of the
 * session cookie.
 *
 * It was copied identically in `campaigns.controller.ts` and in
 * `entityMedia.controller.ts`; with a third writing controller it is worth
 * having just one, or the next copy will diverge.
 */
export function assertMutationOrigin(request: AuthenticatedRequest): void {
    if (request.headers['sec-fetch-site'] === 'cross-site') {
        throw new BadRequestException('Cross-site mutations are not accepted');
    }
    const origin = request.headers.origin;
    if (!origin) return;
    try {
        if (new URL(origin).origin !== new URL(config.discordOAuth.publicBaseUrl).origin) {
            throw new BadRequestException('Invalid request origin');
        }
    } catch (error) {
        if (error instanceof BadRequestException) throw error;
        throw new BadRequestException('Invalid request origin');
    }
}
