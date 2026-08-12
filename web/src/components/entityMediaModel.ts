import type { EntityImage } from '../api/types';

export function entityImageFrom(value: unknown): EntityImage | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<EntityImage>;
    return typeof candidate.id === 'string' &&
        typeof candidate.thumbnailUrl === 'string' &&
        typeof candidate.displayUrl === 'string'
        ? candidate as EntityImage
        : null;
}
