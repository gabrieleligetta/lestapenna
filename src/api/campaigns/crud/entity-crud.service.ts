import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { db } from '../../../db/client';
import { eventRepository, knowledgeRepository } from '../../../db';
import {
    EntityDeleteBlockedError,
    type EntityDeleteReport,
    deleteEntityCascade,
} from '../../../services/entityDeletion';
import type { EntityFragmentRow } from '../../../db/repositories/KnowledgeRepository';
import { isAlignmentHistoryTable } from '../../../db/repositories/shared';
import { MANUAL_EVENT_TYPES } from './entity-crud.enums';
import { parseCrudInput } from './entity-crud.fields';
import {
    CrudEntityType,
    CrudRow,
    ENTITY_CRUD_SPECS,
    EntityCrudSpec,
} from './entity-crud.registry';

export type { EntityDeleteReport };

export interface EventMutation {
    description?: string;
    event_type?: string;
    moral_weight?: number;
    ethical_weight?: number;
}

const WEIGHT_MIN = -10;
const WEIGHT_MAX = 10;

function parseWeight(value: unknown, field: string): number {
    const weight = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(weight) || weight < WEIGHT_MIN || weight > WEIGHT_MAX) {
        throw new BadRequestException(`${field} must be an integer between ${WEIGHT_MIN} and ${WEIGHT_MAX}`);
    }
    return weight;
}

@Injectable()
export class EntityCrudService {
    spec(entityType: CrudEntityType): EntityCrudSpec {
        return ENTITY_CRUD_SPECS[entityType];
    }

    /** The entity, or a 404. Used by every route that starts from a short-id. */
    require(entityType: CrudEntityType, campaignId: number, shortId: string): CrudRow {
        const row = this.spec(entityType).find(campaignId, shortId);
        if (!row) throw new NotFoundException(`${entityType} entry not found`);
        return row;
    }

    create(entityType: CrudEntityType, campaignId: number, body: unknown): CrudRow {
        const spec = this.spec(entityType);
        const input = parseCrudInput(spec.fields, body, 'create');

        const existing = spec.findByInput(campaignId, input);
        if (existing) {
            throw new ConflictException(`${spec.label(existing)} already exists`);
        }
        return spec.create(campaignId, input);
    }

    update(entityType: CrudEntityType, campaignId: number, shortId: string, body: unknown): CrudRow {
        const spec = this.spec(entityType);
        const current = this.require(entityType, campaignId, shortId);
        const input = parseCrudInput(spec.fields, body, 'update');

        // Renaming onto a name already taken is not an error for the repositories —
        // `renameNpcEntry` merges the two records. From here merging has to stay
        // the explicit merge flow, with its preview: here it is a 409.
        const clash = spec.findByInput(campaignId, input);
        if (clash && clash.id !== current.id) {
            throw new ConflictException(`${spec.label(clash)} already exists`);
        }
        return spec.update(campaignId, current, input);
    }

    /**
     * Deletes the entity and everything that names it.
     *
     * Stopping at the entity row would leave the history orphaned and — worse —
     * the RAG card intact: the Bardo would keep answering about an NPC that the
     * site shows as deleted. The sequence follows `deleteQuest`, which is the
     * only cascade that already existed.
     *
     * Media live on object storage: the metadata row falls within the
     * transaction, deleting the object is best-effort and delegated to the caller.
     */
    remove(entityType: CrudEntityType, campaignId: number, shortId: string): {
        entity: CrudRow;
        report: EntityDeleteReport;
        /** Keys of the storage objects left to delete outside the transaction. */
        mediaObjectKeys: string[];
    } {
        const current = this.require(entityType, campaignId, shortId);
        try {
            const outcome = deleteEntityCascade(campaignId, entityType, current);
            return { entity: current, ...outcome };
        } catch (error) {
            // The only case today is the party faction, structural to the campaign.
            if (error instanceof EntityDeleteBlockedError) {
                throw new BadRequestException(error.message);
            }
            throw error;
        }
    }

    // --- History events ------------------------------------------------------

    /**
     * The event, verified as belonging to that entity and that campaign.
     * Without this check a numeric event id would allow editing another
     * entity's history by going through this one's route.
     */
    requireEvent(
        entityType: CrudEntityType,
        campaignId: number,
        entity: CrudRow,
        eventId: number,
    ): { table: string; row: Record<string, unknown> } {
        const spec = this.spec(entityType);
        if (!spec.history) throw new NotFoundException('This entity type has no editable history');

        const row = db.prepare(
            `SELECT * FROM ${spec.history.table} WHERE id = ? AND campaign_id = ?`,
        ).get(eventId, campaignId) as Record<string, unknown> | undefined;
        if (!row) throw new NotFoundException('Event not found');

        const values = spec.history.keyValues(entity);
        const matchesName = spec.history.keyColumns.every((column, index) =>
            String(row[column] ?? '').toLowerCase() === values[index].toLowerCase());
        const matchesId = spec.history.hasEntityId && row.entity_id === entity.id;
        if (!matchesName && !matchesId) throw new NotFoundException('Event not found');

        return { table: spec.history.table, row };
    }

    parseEventMutation(table: string, body: unknown): EventMutation {
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
            throw new BadRequestException('Request body must be an object');
        }
        const source = body as Record<string, unknown>;
        const mutation: EventMutation = {};

        if (source.description !== undefined) {
            const description = String(source.description ?? '').trim();
            if (!description) throw new BadRequestException('description is required');
            if (description.length > 12000) {
                throw new BadRequestException('description must be at most 12000 characters');
            }
            mutation.description = description;
        }

        if (source.event_type !== undefined) {
            const type = String(source.event_type ?? '').trim();
            if (!type || type.length > 40) {
                throw new BadRequestException('event_type must be between 1 and 40 characters');
            }
            mutation.event_type = type;
        }

        const weighted = isAlignmentHistoryTable(table);
        for (const field of ['moral_weight', 'ethical_weight'] as const) {
            if (source[field] === undefined) continue;
            if (!weighted) {
                throw new BadRequestException(`${field} is not available on this entity's history`);
            }
            mutation[field] = parseWeight(source[field], field);
        }

        if (Object.keys(mutation).length === 0) {
            throw new BadRequestException('No editable fields were provided');
        }
        return mutation;
    }

    updateEvent(table: string, row: Record<string, unknown>, mutation: EventMutation): void {
        const updated = eventRepository.updateEvent(
            table,
            Number(row.id),
            mutation.description ?? String(row.description ?? ''),
            undefined,
            mutation.event_type,
            undefined,
            {
                moral_weight: mutation.moral_weight,
                ethical_weight: mutation.ethical_weight,
            },
        );
        if (!updated) throw new NotFoundException('Event not found');
    }

    deleteEvent(table: string, eventId: number): void {
        if (!eventRepository.deleteEvent(table, eventId)) {
            throw new NotFoundException('Event not found');
        }
    }

    /** The `event_type` values the editor offers, plus the one already on the row. */
    eventTypeOptions(current: string | null): string[] {
        const options = new Set<string>(MANUAL_EVENT_TYPES);
        if (current) options.add(current);
        return [...options];
    }

    // --- Memory fragments (RAG) ----------------------------------------------

    listFragments(entityType: CrudEntityType, campaignId: number, entity: CrudRow): EntityFragmentRow[] {
        return knowledgeRepository.listEntityFragments(campaignId, this.spec(entityType).fragmentQuery(entity));
    }

    /**
     * Deletes a fragment, but only if it really is one of those shown for that
     * entity: fragment ids are global to the campaign, and the route goes
     * through a specific entity.
     */
    deleteFragment(
        entityType: CrudEntityType,
        campaignId: number,
        entity: CrudRow,
        fragmentId: number,
    ): void {
        const linked = this.listFragments(entityType, campaignId, entity)
            .some((fragment) => fragment.id === fragmentId);
        if (!linked) throw new NotFoundException('Fragment not found for this entity');
        if (!knowledgeRepository.deleteFragment(campaignId, fragmentId)) {
            throw new NotFoundException('Fragment not found for this entity');
        }
    }
}
